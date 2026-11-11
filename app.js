"use strict";

/* =========================================================================
   VoiceLayer V1 — moteur PCM dans l'horloge de l'AudioContext
   -------------------------------------------------------------------------
   Ce qui change par rapport à la V0.2 :
   - la capture du micro ne passe plus par MediaRecorder (WebM/Opus, horloge
     opaque) mais par un AudioWorklet branché sur le MÊME AudioContext que la
     lecture des accompagnements. L'instant du premier échantillon capturé est
     connu (firstTime), donc l'alignement avec la piste d'accompagnement est
     calculé en échantillons : plus de décalage logiciel.
   - les pistes sont stockées en WAV PCM 16 bits : téléchargeables telles
     quelles, sans décodage, et le mix est une simple somme d'échantillons.
   - plus de Service Worker (il ne servait à rien en local et ressert un
     ancien JS) : on désinscrit même celui qui aurait survécu.
   ========================================================================= */

const MAX_TRACKS = 10;
const DB_NAME = "voicelayer-db";
const DB_VERSION = 1;
const MIC_PREF_KEY = "voicelayer-microphone-id";
const MUTE_PREF_KEY = "voicelayer-all-muted";
const OFFSET_PREF_PREFIX = "voicelayer-offset-ms:";
const PREROLL = 0.25;          // marge de planification de la lecture (s)
const MIN_TAKE = 0.15;         // durée mini d'une prise exploitable (s)

const $ = (id) => document.getElementById(id);

const ui = {
  engine: $("enginePill"),
  projectName: $("projectName"), newProject: $("newProjectBtn"),
  importBtn: $("importBtn"), saveProject: $("saveProjectBtn"), loadProject: $("loadProjectBtn"),
  importInput: $("importInput"), projectInput: $("projectInput"),
  micSelect: $("micSelect"), refreshMics: $("refreshMicsBtn"), testMic: $("testMicBtn"),
  micTestText: $("micTestText"), micState: $("micState"), meter: $("meterFill"), offset: $("offsetMs"),
  micInfo: $("micInfo"), levelReadout: $("levelReadout"),
  monitorBtn: $("monitorBtn"), monitorVolume: $("monitorVolume"), monitorHint: $("monitorHint"),
  position: $("positionReadout"), toStart: $("toStartBtn"),
  record: $("recordBtn"), stop: $("stopBtn"), play: $("playBtn"), timer: $("timer"), status: $("statusMessage"),
  list: $("tracks"), count: $("trackCount"), export: $("exportBtn"), muteAll: $("muteAllBtn"), mixHint: $("mixHint"),
};

let ctx = null;
let micStream = null, micSource = null, analyser = null, meterFrame = null, meterData = null;
let meterFloat = null, maxMicPeak = 0, recPeak = 0, maxRecPeak = 0, micArmedDevice = null;
let fallbackRecorder = null, fallbackChunks = [];
let recorderNode = null, silentGain = null, pendingCapture = null;
let monitorGain = null, monitoring = false;
// position dans le projet, en millisecondes : c'est l'endroit d'où repart la
// lecture et où démarrera la prochaine prise.
let positionMs = 0, playBaseMs = 0, captureStartMs = 0;
let testActive = false;

let tracks = [];
let allMuted = localStorage.getItem(MUTE_PREF_KEY) === "true";
let state = "idle";                 // idle | countdown | recording | playing
let captureStartAt = 0, captureFirstTime = -1;
let playSources = [], playGains = new Map();
// génération de lecture : tout gestionnaire « fin de source » d'une lecture
// précédente doit être ignoré, sinon il coupe la lecture suivante.
let playToken = 0;
let bufferCache = new Map();
let timerInterval = null;
let countdownInterval = null;
let takeWatchdog = null;

/* ------------------------------ utilitaires ------------------------------ */

function setStatus(message) { ui.status.textContent = message; }

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function friendlyMicError(error) {
  const messages = {
    NotAllowedError: "autorisation refusée dans Chrome ou Windows",
    NotFoundError: "aucun microphone disponible",
    NotReadableError: "microphone occupé par une autre application",
    OverconstrainedError: "le microphone sélectionné n'est plus disponible",
    SecurityError: "accès micro bloqué : utilise http://127.0.0.1 ou HTTPS",
    AbortError: "capture interrompue par le système",
  };
  return messages[error && error.name] || (error && error.message) || "erreur inconnue";
}

function offsetKey() { return OFFSET_PREF_PREFIX + (ui.micSelect.value || "default"); }

function currentOffsetMs() {
  const v = Number(ui.offset.value);
  return Number.isFinite(v) ? v : 0;
}

/* ------------------------------ WAV <-> PCM ------------------------------ */

function wavFromInt16(int16, sampleRate, channels) {
  const ch = channels === 2 ? 2 : 1;
  const frames = int16.length;
  const dataSize = frames * ch * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    const s = int16[i];
    for (let c = 0; c < ch; c++) { view.setInt16(o, s, true); o += 2; }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/* Lit un WAV PCM 16 bits et renvoie le canal gauche en Int16.
   Robuste aux chunks supplémentaires (LIST, fact…) que certains encodeurs ajoutent. */
async function readPcm16(blob) {
  const ab = await blob.arrayBuffer();
  if (ab.byteLength < 44) throw new Error("fichier audio trop court");
  const view = new DataView(ab);

  const tag = (p) => String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("ce n'est pas un fichier WAV");

  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= ab.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, ab.byteLength - body);
    }
    pos = body + size + (size % 2);
  }

  if (!fmt || dataOff < 0) throw new Error("WAV incomplet");
  if (fmt.bits !== 16) throw new Error("seul le PCM 16 bits est géré ici");

  const channels = Math.max(1, fmt.channels);
  const frames = Math.floor(dataLen / (channels * 2));
  const samples = new Int16Array(frames);
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    samples[i] = view.getInt16(p, true);     // canal gauche seulement
    p += channels * 2;
  }
  return { samples, sampleRate: fmt.sampleRate, channels };
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = float32[i] < -1 ? -1 : float32[i] > 1 ? 1 : float32[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/* Niveau max d'un bloc PCM. Sert à distinguer une prise réelle d'une prise
   silencieuse : « je n'entends rien » veut dire soit micro qui ne capte rien,
   soit lecture muette. Ce nombre tranche entre les deux. */
function peakOf(int16) {
  let peak = 0;
  for (let i = 0; i < int16.length; i++) {
    const a = int16[i] < 0 ? -int16[i] : int16[i];
    if (a > peak) peak = a;
  }
  return peak / 32768;
}

const SILENT_PEAK = 0.004;

/* ------------------------------- IndexedDB ------------------------------- */

let db = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks", { keyPath: "id" });
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeItem(store, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteItem(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------------------- moteur audio ------------------------------ */

async function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

async function initRecorder() {
  if (recorderNode) return;
  await ensureCtx();
  await ctx.audioWorklet.addModule("worklet-recorder.js?v=1");

  recorderNode = new AudioWorkletNode(ctx, "pcm-recorder", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
  });

  // Le processeur n'écrit jamais dans sa sortie : la branche est donc
  // silencieuse par construction. On la branche DIRECTEMENT sur la destination
  // (et non via un gain nul) pour que le graphe la tire à coup sûr — un noeud
  // dont la sortie n'aboutit pas à la destination peut ne jamais être traité.
  recorderNode.connect(ctx.destination);

  recorderNode.port.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "level") {
      recPeak = data.peak;
      if (data.peak > maxRecPeak) maxRecPeak = data.peak;
      return;
    }
    if (data.type === "done" && pendingCapture) {
      const pending = pendingCapture;
      pendingCapture = null;
      pending.resolve(data);
    }
  };
}

/* ------------------------- retour casque (monitoring) -------------------- */

/* Le micro est renvoyé vers la sortie audio : l'utilisateur s'entend en direct.
   Branchement PARALLÈLE au chemin d'enregistrement — le retour ne modifie donc
   jamais ce qui est capté. Gain à 0 par défaut : sans casque, ça hurle. */
function ensureMonitor() {
  if (monitorGain || !ctx) return monitorGain;
  monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;
  monitorGain.connect(ctx.destination);
  return monitorGain;
}

function applyMonitorGain() {
  if (!monitorGain || !ctx) return;
  const volume = Number(ui.monitorVolume.value);
  const target = monitoring ? (Number.isFinite(volume) ? volume : 1) : 0;
  // Affectation directe, sans automatisation : quand le micro est fermé (entre
  // deux prises) le noeud n'est plus rendu par le graphe, et une valeur
  // programmée par setValueAtTime reste alors bloquée à son ancienne valeur.
  // Ici la valeur appliquée est toujours celle qu'on lit.
  monitorGain.gain.value = target;
}

function updateMonitorUi() {
  ui.monitorBtn.textContent = monitoring ? "🎧 Retour casque activé — couper" : "🎧 Activer le retour casque";
  ui.monitorBtn.setAttribute("aria-pressed", String(monitoring));
  ui.monitorVolume.parentElement.hidden = !monitoring;
  ui.monitorHint.textContent = monitoring
    ? "Actif pendant le test et les prises. Le micro se ferme entre deux : le retour s'arrête aussi."
    : "Désactivé par défaut. Casque ou écouteurs obligatoires : avec des enceintes, larsen immédiat.";
}

function isTouchDevice() {
  return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

async function toggleMonitoring() {
  try {
    if (!monitoring) {
      // Sur téléphone, le haut-parleur est à quelques centimètres du micro :
      // le larsen est immédiat. Le message s'adapte au matériel.
      const message = isTouchDevice()
        ? "Écouteurs ou casque obligatoires.\n\nSur un téléphone, activer le retour avec le haut-parleur produit un larsen immédiat.\n\nActiver le retour dans les écouteurs ?"
        : "Mets un casque avant d'activer.\n\nSans casque, le micro reprend le son des haut-parleurs et produit un larsen immédiat.\n\nActiver le retour casque ?";
      const ok = confirm(message);
      if (!ok) return;

      await ensureCtx();
      await initRecorder();
      ensureMonitor();
      await armMic();          // ouvre le micro et branche le retour
      monitoring = true;
      applyMonitorGain();
      updateMonitorUi();
      startMeter();
      setStatus("Retour casque activé : tu t'entends en direct. Le retour passe par le logiciel, il est donc décalé de quelques dizaines de ms — c'est normal. Baisse « Volume du retour » en cas de sifflement.");
    } else {
      monitoring = false;
      applyMonitorGain();
      updateMonitorUi();
      setStatus("Retour casque coupé.");
    }
  } catch (error) {
    monitoring = false;
    applyMonitorGain();
    updateMonitorUi();
    setStatus(`Retour casque impossible : ${friendlyMicError(error)}`);
  }
}

async function refreshMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setStatus("La liste des microphones n'est pas disponible dans ce navigateur.");
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const saved = localStorage.getItem(MIC_PREF_KEY) || "";
    const current = ui.micSelect.value || saved;

    ui.micSelect.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Microphone par défaut du navigateur";
    ui.micSelect.append(def);

    inputs.forEach((device, i) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${i + 1}`;
      ui.micSelect.append(option);
    });

    if (current && inputs.some((d) => d.deviceId === current)) ui.micSelect.value = current;
    else if (saved && inputs.some((d) => d.deviceId === saved)) ui.micSelect.value = saved;
    else ui.micSelect.value = "";

    loadOffsetForCurrentMic();

    if (!inputs.length) setStatus("Aucun microphone détecté par le navigateur.");
  } catch (error) {
    setStatus(`Impossible de lire les périphériques audio : ${error.message}`);
  }
}

function loadOffsetForCurrentMic() {
  const saved = localStorage.getItem(offsetKey());
  ui.offset.value = saved === null ? "0" : saved;
}

function micConstraints() {
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (ui.micSelect.value) audio.deviceId = { exact: ui.micSelect.value };
  return { audio, video: false };
}

async function armMic() {
  const wanted = ui.micSelect.value || "";

  // On garde le flux déjà ouvert s'il correspond au micro demandé. Fermer puis
  // réouvrir le périphérique donne parfois, sous Windows, un flux qui ne délivre
  // que des zéros : c'est exactement ce que produisait un aller-retour test/prise.
  if (micStream && micArmedDevice === wanted && micStream.getAudioTracks().some((t) => t.readyState === "live")) {
    return micStream;
  }

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micSource) { try { micSource.disconnect(); } catch { } micSource = null; }

  micStream = await navigator.mediaDevices.getUserMedia(micConstraints());
  micArmedDevice = wanted;
  localStorage.setItem(MIC_PREF_KEY, ui.micSelect.value || "");

  micSource = ctx.createMediaStreamSource(micStream);
  micSource.connect(recorderNode);
  ensureMonitor();
  micSource.connect(monitorGain);
  applyMonitorGain();

  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  micSource.connect(analyser);
  meterData = new Uint8Array(analyser.fftSize);
  meterFloat = new Float32Array(analyser.fftSize);

  const track = micStream.getAudioTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};
  ui.micInfo.textContent = track
    ? `Micro réellement ouvert : « ${track.label || "sans nom"} » · ${settings.sampleRate || "?"} Hz · ${settings.channelCount || "?"} canal(aux)`
    : "";

  return micStream;
}

function updateLevelReadout() {
  if (!ui.levelReadout) return;
  const mic = `${Math.round(maxMicPeak * 100)} %`;
  const rec = state === "recording" ? `${Math.round(maxRecPeak * 100)} %` : "—";
  // On affiche les MAXIMUMS depuis le début de la prise, pas l'instant présent :
  // un pic instantané peut tomber dans un creux et faire croire à du silence.
  ui.levelReadout.textContent = `niveau micro (max) ${mic} · niveau enregistré (max) ${rec}`;
  ui.levelReadout.classList.toggle("hint-alert", state === "recording" && maxMicPeak > SILENT_PEAK && maxRecPeak < SILENT_PEAK);
}

function startMeter() {
  maxMicPeak = 0;
  const draw = () => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(meterFloat);
    let sum = 0, peak = 0;
    for (let i = 0; i < meterFloat.length; i++) {
      const v = meterFloat[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / meterFloat.length);
    if (peak > maxMicPeak) maxMicPeak = peak;
    ui.meter.style.width = `${Math.min(100, Math.max(0, rms * 450))}%`;
    updateLevelReadout();
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  ui.meter.style.width = "0%";
  if (ui.levelReadout) {
    ui.levelReadout.textContent = "niveau micro — · niveau enregistré —";
    ui.levelReadout.classList.remove("hint-alert");
  }
}

function releaseMic() {
  stopMeter();
  if (micSource) { try { micSource.disconnect(); } catch { } micSource = null; }
  analyser = null;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  micArmedDevice = null;
}

/* Chemin de secours : un MediaRecorder en parallèle de la capture PCM.
   Si la capture PCM revient vide alors que le micro émettait, on récupère la
   prise par ce chemin plutôt que de perdre la voix de l'utilisateur. */
function startFallback() {
  fallbackChunks = [];
  fallbackRecorder = null;
  if (!window.MediaRecorder || !micStream) return;
  try {
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((t) => MediaRecorder.isTypeSupported(t));
    fallbackRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    fallbackRecorder.ondataavailable = (e) => { if (e.data && e.data.size) fallbackChunks.push(e.data); };
    fallbackRecorder.start(200);
  } catch {
    fallbackRecorder = null;
  }
}

async function stopFallback() {
  const rec = fallbackRecorder;
  fallbackRecorder = null;
  if (!rec || rec.state === "inactive") return;
  await new Promise((resolve) => {
    rec.onstop = resolve;
    try { rec.stop(); } catch { resolve(); }
  });
}

async function fallbackToPcm() {
  if (!fallbackChunks.length) return null;
  const blob = new Blob(fallbackChunks, { type: fallbackChunks[0].type || "audio/webm" });
  if (blob.size < 1000) return null;
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * ctx.sampleRate)), ctx.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const pcm = floatToInt16(rendered.getChannelData(0));
  // Le MediaRecorder démarre de façon asynchrone : on retire la marge de
  // pré-roll, ce qui laisse une incertitude de quelques dizaines de ms —
  // rattrapable avec les boutons de recalage 10 ms.
  const trim = Math.min(pcm.length, Math.round(PREROLL * ctx.sampleRate));
  return pcm.slice(trim);
}

async function toggleMicTest() {
  if (testActive) {
    testActive = false;
    releaseMic();
    ui.testMic.textContent = "Tester le microphone";
    ui.micTestText.textContent = "Parle pour vérifier le niveau sonore.";
    ui.micState.textContent = "Non testé";
    ui.micState.className = "mic-state";
    setStatus("Test microphone arrêté.");
    return;
  }

  if (state !== "idle") {
    setStatus("Termine l'enregistrement en cours avant de tester le microphone.");
    return;
  }

  try {
    await ensureCtx();
    await initRecorder();
    await armMic();
    startMeter();
    testActive = true;
    ui.testMic.textContent = "Arrêter le test";
    ui.micTestText.textContent = "Parle : la jauge doit réagir.";
    ui.micState.textContent = "Test en cours";
    ui.micState.className = "mic-state active";
    setStatus("Microphone actif. Vérifie que la jauge réagit à ta voix.");
  } catch (error) {
    releaseMic();
    testActive = false;
    ui.micState.textContent = "Erreur";
    ui.micState.className = "mic-state error";
    setStatus(`Test micro impossible : ${friendlyMicError(error)}`);
  }
}

/* --------------------------- lecture des pistes -------------------------- */

async function bufferFor(track) {
  const key = `${track.id}:${track.createdAt}`;
  if (bufferCache.has(key)) return bufferCache.get(key);
  const pcm = await readPcm16(track.blob);
  const buffer = ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
  buffer.copyToChannel(int16ToFloat32(pcm.samples), 0);
  bufferCache.set(key, buffer);
  return buffer;
}

function gainFor(track) {
  return (allMuted || track.muted) ? 0 : (typeof track.volume === "number" ? track.volume : 1);
}

function stopPlayback(keepPosition = false) {
  // invalide les gestionnaires « fin de source » des lectures précédentes :
  // sans ça, une source arrêtée par un déplacement du curseur déclenche son
  // « ended » APRÈS le redémarrage et coupe la nouvelle lecture.
  playToken++;
  playSources.forEach((s) => { try { s.stop(); } catch { } });
  playSources = [];
  playGains.clear();
  stopPlayhead();
  if (!keepPosition) positionMs = 0;
  if (state === "playing") state = "idle";
  ui.play.textContent = "▶ Tout écouter";
  updatePositionUi();
  paintPlayhead(positionMs, true);
}

function pausePlayback() {
  if (state !== "playing") return;
  freezePosition();
  const at = positionMs;
  stopPlayback(true);
  state = "paused";
  ui.play.textContent = "▶ Reprendre";
  updatePositionUi();
  paintPlayhead(at, true);
  setStatus(`Pause à ${fmt(at / 1000)}. Le curseur reste planté là : « Enregistrer une piste » fera démarrer la nouvelle prise à cet endroit, et « Reprendre » continue la lecture.`);
}

function backToStart() {
  if (state === "playing") stopPlayback();
  positionMs = 0;
  updatePositionUi();
  paintPlayhead(0, true);
  setStatus("Position remise au début du projet.");
}

/* Chaque piste a une position de départ dans le projet (startMs). Depuis une
   position fromMs, une piste déjà commencée reprend en plein milieu de son
   tampon (offset), une piste à venir est décalée dans le temps (delay). */
async function scheduleTracks(items, when, fromMs = 0) {
  const sources = [];
  for (const item of items) {
    const delay = (item.startMs || 0) / 1000 - fromMs / 1000;
    const offset = delay < 0 ? -delay : 0;
    if (offset >= item.buffer.duration) continue;

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = item.buffer;
    gain.gain.value = item.gain;
    source.connect(gain).connect(ctx.destination);
    const at = (when === undefined ? ctx.currentTime : when) + Math.max(0, delay);
    source.start(at, offset);
    sources.push(source);
    if (item.id) {
      playGains.set(item.id, gain);
      source.addEventListener("ended", () => {
        if (playGains.get(item.id) === gain) playGains.delete(item.id);
      }, { once: true });
    }
  }
  playSources = sources;
  return sources;
}

async function playAll(fromMs = positionMs) {
  if (!tracks.length) return;
  try {
    await ensureCtx();
    stopPlayback(true);
    const token = playToken;
    setStatus("Préparation de la lecture…");

    // au-delà de la fin, on repart du début plutôt que de ne rien jouer
    // (fromMs est en millisecondes, total en secondes : comparer les mêmes unités)
    const total = projectDuration();
    const from = Math.max(0, fromMs >= (total - 0.05) * 1000 ? 0 : fromMs);

    const items = [];
    for (const track of tracks) {
      items.push({
        id: track.id,
        buffer: await bufferFor(track),
        gain: gainFor(track),
        startMs: track.startMs || 0,
      });
    }

    const startAt = ctx.currentTime + 0.1;
    const sources = await scheduleTracks(items, startAt, from);
    if (!sources.length) {
      state = "idle";
      setStatus("Rien à écouter à partir de cette position.");
      return;
    }

    state = "playing";
    positionMs = from;
    startPlayhead(startAt, from);
    updatePositionUi();
    ui.play.textContent = "⏸ Pause";
    setStatus(allMuted
      ? "Lecture lancée, mais TOUTES LES PISTES SONT MUETTES : tu n'entendras rien. Clique « Réactiver toutes les pistes »."
      : "Lecture de toutes les pistes.");

    let ended = 0;
    sources.forEach((source) => {
      source.addEventListener("ended", () => {
        if (token !== playToken) return;
        ended++;
        if (ended === sources.length && state === "playing") stopPlayback();
      }, { once: true });
    });
  } catch (error) {
    state = "idle";
    setStatus(`Lecture impossible : ${error.message}`);
  }
}

async function playSingle(track) {
  try {
    await ensureCtx();
    stopPlayback(true);
    const token = playToken;
    const buffer = await bufferFor(track);
    const startAt = ctx.currentTime + 0.05;
    const startMs = track.startMs || 0;
    await scheduleTracks([{ id: track.id, buffer, gain: gainFor(track), startMs }], startAt, startMs);
    state = "playing";
    startPlayhead(startAt, startMs);
    ui.play.textContent = "⏸ Pause";
    setStatus(`Lecture : ${track.name || "piste"}.`);
    const source = playSources[0];
    source.addEventListener("ended", () => { if (token === playToken && state === "playing") stopPlayback(); }, { once: true });
  } catch (error) {
    setStatus(`Lecture impossible : ${error.message}`);
  }
}

/* ---------------------------- enregistrement ---------------------------- */

function setTransportLocked(locked) {
  ui.record.disabled = locked;
  ui.stop.disabled = !locked;
  ui.export.disabled = locked || !tracks.length;
  ui.micSelect.disabled = locked;
  ui.testMic.disabled = locked;
  ui.refreshMics.disabled = locked;
  ui.newProject.disabled = locked;
  ui.importBtn.disabled = locked;
  ui.loadProject.disabled = locked;
  ui.play.disabled = locked;
  ui.toStart.disabled = locked;
}

async function startRecording() {
  // Depuis la lecture, on fige l'instant courant : la prise démarrera là où on
  // en est, sans avoir à arrêter puis repositionner quoi que ce soit.
  if (state === "playing") {
    freezePosition();
    stopPlayback(true);
  } else if (state !== "idle" && state !== "paused") {
    return;
  }
  captureStartMs = positionMs;

  if (tracks.length >= MAX_TRACKS) {
    setStatus(`Limite de ${MAX_TRACKS} pistes atteinte. Supprime une piste pour continuer.`);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Ce navigateur ne donne pas accès au microphone. Essaie Chrome récent.");
    return;
  }

  try {
    await ensureCtx();
    await initRecorder();

    if (testActive) {
      testActive = false;
      ui.testMic.textContent = "Tester le microphone";
    }

    // Prépare l'accompagnement AVANT le décompte : décoder pendant la prise
    // créerait précisément le retard qu'on veut supprimer.
    const backing = [];
    for (const track of tracks) {
      backing.push({
        id: track.id,
        buffer: await bufferFor(track),
        gain: gainFor(track),
        startMs: track.startMs || 0,
      });
    }

    await armMic();

    state = "countdown";
    setTransportLocked(true);
    stopPlayback(true);
    startMeter();               // le micro est mesuré pendant le décompte
    ui.timer.textContent = "03";
    setStatus(captureStartMs > 50
      ? `Prépare-toi… démarrage dans 3 secondes, la prise commencera à ${fmt(captureStartMs / 1000)} du projet.`
      : "Prépare-toi… démarrage dans 3 secondes. Parle : la jauge doit bouger.");

    let count = 3;
    countdownInterval = setInterval(async () => {
      count--;
      if (count > 0) { ui.timer.textContent = `0${count}`; return; }
      clearInterval(countdownInterval);
      countdownInterval = null;

      // Pas de blocage ici : se taire pendant le décompte est normal, c'est le
      // moment où l'on se prépare. Le silence éventuel est signalé PENDANT la
      // prise, et la récupération automatique reste en filet.
      await launchTake(backing);
    }, 1000);
  } catch (error) {
    clearInterval(countdownInterval);
    countdownInterval = null;
    releaseMic();
    state = "idle";
    setTransportLocked(false);
    ui.micState.textContent = "Erreur";
    ui.micState.className = "mic-state error";
    setStatus(`Microphone indisponible : ${friendlyMicError(error)}`);
  }
}

async function launchTake(backing) {
  if (state !== "countdown") {
    // L'utilisateur a annulé pendant le décompte.
    releaseMic();
    setTransportLocked(false);
    return;
  }

  clearInterval(countdownInterval);
  countdownInterval = null;

  const startAt = ctx.currentTime + PREROLL;
  captureStartAt = startAt;
  captureFirstTime = -1;
  maxMicPeak = 0;
  recPeak = 0;
  maxRecPeak = 0;

  pendingCapture = null;
  recorderNode.port.postMessage({ cmd: "start" });
  startFallback();

  if (backing.length) await scheduleTracks(backing, startAt, captureStartMs);

  state = "recording";
  startPlayhead(startAt, captureStartMs);
  ui.micState.textContent = "Enregistrement";
  ui.micState.className = "mic-state active";
  setStatus(backing.length
    ? "Enregistrement en cours… chante sur les pistes déjà enregistrées."
    : "Enregistrement en cours…");

  // Avertissement, jamais un blocage : si rien n'est arrivé après 2 secondes,
  // on le dit et l'enregistrement continue (l'accompagnement est audible).
  takeWatchdog = setTimeout(() => {
    if (state !== "recording") return;
    if (maxMicPeak < SILENT_PEAK && maxRecPeak < SILENT_PEAK) {
      ui.micState.textContent = "Aucun son ?";
      ui.micState.className = "mic-state error";
      setStatus("Aucun son depuis 2 secondes. Si tu es en train de chanter, vérifie le micro et le niveau d'entrée Windows. L'enregistrement continue ; la prise sera récupérée automatiquement si le signal revient.");
    }
  }, 2000);

  timerInterval = setInterval(() => {
    ui.timer.textContent = fmt(Math.max(0, ctx.currentTime - startAt));
  }, 100);
}

async function stopRecording() {
  if (state === "countdown") {
    clearInterval(countdownInterval);
    countdownInterval = null;
    state = "idle";
    releaseMic();
    setTransportLocked(false);
    ui.timer.textContent = "00:00";
    setStatus("Décompte annulé.");
    return;
  }
  if (state !== "recording") return;

  state = "finalizing";
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (takeWatchdog) { clearTimeout(takeWatchdog); takeWatchdog = null; }
  // on fige la position exacte de l'arrêt : le curseur reste là où la prise
  // s'est terminée, donc là où reprendra la suivante.
  freezePosition();
  stopPlayback(true);

  const done = await new Promise((resolve) => {
    pendingCapture = { resolve };
    recorderNode.port.postMessage({ cmd: "stop" });
  });

  await stopFallback();

  await finalizeTake(done);
}

async function finalizeTake(data) {
  const sampleRate = ctx.sampleRate;

  try {
    let total = 0;
    for (const chunk of data.chunks || []) total += chunk.byteLength / 2;

    const all = new Int16Array(total);
    let offset = 0;
    for (const chunk of data.chunks) {
      const part = new Int16Array(chunk);
      all.set(part, offset);
      offset += part.length;
    }

    // Alignement : l'échantillon 0 de la piste doit tomber sur startAt, l'instant
    // où l'accompagnement a été planifié. firstTime = instant du premier bloc
    // capturé, dans la même horloge. La différence est donc exacte en échantillons.
    const firstTime = data.firstTime >= 0 ? data.firstTime : captureStartAt;
    const softwareDrop = Math.round((captureStartAt - firstTime) * sampleRate);
    const calibrationDrop = Math.round((currentOffsetMs() / 1000) * sampleRate);
    const drop = Math.max(0, softwareDrop + calibrationDrop);

    const kept = all.length > drop ? all.slice(drop) : new Int16Array(0);

    let pcm = kept;
    let peak = peakOf(kept);
    let usedFallback = false;

    // Filet de sécurité : la capture PCM est vide alors que le micro émettait.
    // On récupère la prise par le MediaRecorder lancé en parallèle.
    if (peak < SILENT_PEAK && fallbackChunks.length) {
      try {
        const rescued = await fallbackToPcm();
        if (rescued && rescued.length > sampleRate * MIN_TAKE && peakOf(rescued) >= SILENT_PEAK) {
          pcm = rescued;
          peak = peakOf(rescued);
          usedFallback = true;
        }
      } catch {
        /* on garde la prise PCM vide, rien n'est perdu */
      }
    }

    const duration = pcm.length / sampleRate;

    if (duration < MIN_TAKE) throw new Error(total
      ? "prise trop courte, rien n'a été conservé"
      : "l'enregistreur n'a reçu aucun échantillon");

    const track = {
      id: crypto.randomUUID(),
      name: `Piste ${tracks.length + 1}`,
      blob: wavFromInt16(pcm, sampleRate, 1),
      sampleRate,
      duration,
      // position de la prise sur la ligne de temps du projet : c'est ce qui
      // permet d'enregistrer en plein milieu de la lecture des autres pistes.
      startMs: Math.round(captureStartMs),
      peak,
      volume: 1,
      muted: false,
      createdAt: Date.now(),
    };

    await storeItem("tracks", track);
    tracks.push(track);
    renderTracks();

    ui.timer.textContent = fmt(duration);

    if (usedFallback) {
      ui.micState.textContent = "Mode secours";
      ui.micState.className = "mic-state";
      setStatus(`La capture PCM est revenue vide, mais la prise a été récupérée par le chemin de secours : ${fmt(duration)}, niveau max ${Math.round(peak * 100)} %. L'alignement peut être décalé de quelques dizaines de ms : recale avec les boutons 10 ms. Signale-moi ce cas, c'est un défaut à corriger.`);
    } else if (peak < SILENT_PEAK) {
      ui.micState.textContent = "Micro muet ?";
      ui.micState.className = "mic-state error";

      // Deux causes très différentes, deux messages différents : le micro
      // n'émet rien (matériel, périphérique, autorisation) ou il émet et
      // c'est l'enregistreur qui ne reçoit rien (défaut de l'application).
      if (maxMicPeak >= SILENT_PEAK) {
        setStatus(`DÉFAUT DE L'APPLICATION, pas de ton matériel : le micro émettait du son (niveau micro ${Math.round(maxMicPeak * 100)} %) mais l'enregistreur a reçu ${Math.round(peak * 100)} %. Les ${fmt(duration)} de la prise sont vides. Signale-moi ce message tel quel.`);
      } else {
        setStatus(`Prise SILENCIEUSE : le micro n'envoie aucun son (niveau micro 0 % pendant ${fmt(duration)}). Côté matériel : vérifie le micro choisi dans « Micro réellement ouvert » ci-dessus, puis Paramètres Windows › Système › Son › Entrée (périphérique + niveau). La prise vide est conservée, ⤓ pour la supprimer après vérification.`);
      }
    } else {
      ui.micState.textContent = "Prêt";
      ui.micState.className = "mic-state";
      setStatus(`Piste enregistrée : ${fmt(duration)}, niveau max ${Math.round(peak * 100)} % (${Math.round(track.blob.size / 1024)} Ko)`
        + (track.startMs > 50 ? ` · départ ${fmt(track.startMs / 1000)} du projet` : "") + ".");
    }
  } catch (error) {
    setStatus(`Piste non enregistrée : ${error.message}`);
  } finally {
    if (takeWatchdog) { clearTimeout(takeWatchdog); takeWatchdog = null; }
    releaseMic();
    state = "idle";
    setTransportLocked(false);
    if (!tracks.length) ui.timer.textContent = "00:00";
    // le curseur reste sur le départ de la prise : on voit où reprendre la suite
    paintPlayhead(positionMs, true);
  }
}

/* ------------------------------- affichage ------------------------------ */

function updateMuteAllButton() {
  ui.muteAll.textContent = allMuted ? "🔊 Réactiver toutes les pistes" : "🔇 Couper toutes les pistes";
  ui.muteAll.setAttribute("aria-pressed", String(allMuted));
  ui.mixHint.textContent = allMuted
    ? "⚠️ Toutes les pistes sont muettes : la lecture sera silencieuse. Le micro, lui, reste actif et l'enregistrement continue."
    : "Le mute général ne coupe ni le micro ni l'enregistrement.";
  ui.mixHint.classList.toggle("hint-alert", allMuted);
}

function applyGainToLivePlayback(track) {
  const gain = playGains.get(track.id);
  if (gain) gain.gain.value = gainFor(track);
}

function setMasterMuted(muted) {
  allMuted = muted;
  localStorage.setItem(MUTE_PREF_KEY, String(allMuted));
  tracks.forEach((t) => applyGainToLivePlayback(t));
  updateMuteAllButton();
  renderTracks();
  setStatus(allMuted
    ? "Toutes les pistes sont muettes. Le micro reste actif, l'enregistrement continue."
    : "Toutes les pistes sont réactivées.");
}

async function setTrackMuted(track, muted) {
  track.muted = muted;
  await storeItem("tracks", track);
  applyGainToLivePlayback(track);
  renderTracks();
  setStatus(track.muted
    ? `${track.name || "Piste"} mise en sourdine (le volume est conservé).`
    : `${track.name || "Piste"} réactivée.`);
}

async function storeVolume(track, value) {
  track.volume = value;
  applyGainToLivePlayback(track);
  await storeItem("tracks", track);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function safeName(name) {
  return (name || "VoiceLayer").trim().replace(/[^\w\-]+/g, "_").slice(0, 60) || "VoiceLayer";
}

/* --------------------------- formes d'onde ------------------------------ */

/* Toutes les pistes sont dessinées sur LA MÊME échelle de temps (0 → durée du
   projet). C'est ce qui permet de voir où l'on démarre par rapport aux autres
   prises, et donc de se synchroniser. L'amplitude, elle, est normalisée piste
   par piste : une voix douce reste lisible sans écraser les autres. */
const waveCache = new Map();
let playheadRaf = null;
let playStart = null;
let lastPositionPaint = 0;

function projectDuration() {
  return tracks.reduce((max, track) => Math.max(max, (track.startMs || 0) / 1000 + (track.duration || 0)), 0);
}

/* On peut modifier les pistes à l'arrêt comme en pause : c'est justement en pause
   qu'on recale et qu'on décide où démarrera la prise suivante. */
function canEdit() {
  return state === "idle" || state === "paused";
}

function updatePositionUi() {
  const total = projectDuration();
  const pos = Math.min(positionMs / 1000, total);
  ui.position.textContent = `position ${fmt(pos)} · durée ${fmt(total)}`
    + (positionMs > 0.05 ? ` · prochaine prise à ${fmt(positionMs / 1000)}` : "");
}

/* Fige la position courante de la lecture, pour pouvoir repartir de là. */
function freezePosition() {
  if (!ctx || playStart === null) return;
  positionMs = playBaseMs + Math.max(0, ctx.currentTime - playStart) * 1000;
}

async function waveformFor(track) {
  const key = `${track.id}:${track.createdAt}`;
  if (waveCache.has(key)) return waveCache.get(key);

  const pcm = await readPcm16(track.blob);
  const buckets = 1400;
  const step = pcm.samples.length / buckets;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * step);
    const end = Math.max(start + 1, Math.min(pcm.samples.length, Math.floor((b + 1) * step)));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.samples[i] / 32768;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }

  const wave = { min, max, duration: pcm.samples.length / pcm.sampleRate };
  waveCache.set(key, wave);
  return wave;
}

function drawWave(canvas, wave, track, total) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(60, canvas.clientWidth || canvas.parentElement?.clientWidth || 300);
  const height = 42;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  const mid = height / 2;
  g.strokeStyle = "rgba(141,181,255,.22)";
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(width, mid);
  g.stroke();

  if (!wave || !total) return;

  const silent = typeof track.peak === "number" && track.peak < SILENT_PEAK;
  g.fillStyle = track.muted
    ? "rgba(148,163,184,.5)"
    : silent ? "rgba(255,150,160,.8)" : "rgba(141,181,255,.9)";

  // normalisation : la crête de la piste occupe 90 % de la demi-hauteur, avec
  // un plafond pour ne pas transformer le souffle d'une piste muette en bloc plein.
  const norm = Math.min(20, 0.9 / Math.max(0.03, typeof track.peak === "number" ? track.peak : 1));

  const count = wave.min.length;
  const from = Math.min(width, Math.round(((track.startMs || 0) / 1000 / total) * width));
  const span = Math.max(1, (wave.duration / total) * width);
  const columns = Math.max(1, Math.round(span));

  for (let x = 0; x < columns && from + x < width; x++) {
    const b0 = Math.floor((x / columns) * count);
    const b1 = Math.min(count, Math.max(b0 + 1, Math.floor(((x + 1) / columns) * count)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      if (wave.min[b] < lo) lo = wave.min[b];
      if (wave.max[b] > hi) hi = wave.max[b];
    }
    const top = mid - Math.min(1, hi * norm) * (mid - 2);
    const bottom = mid - Math.max(-1, lo * norm) * (mid - 2);
    g.fillRect(from + x, top, 1, Math.max(1, bottom - top));
  }
}

function formatTick(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${Math.round(seconds)} s`;
}

function renderRuler(ruler, total) {
  ruler.innerHTML = "";
  if (!total) return;
  const step = [2, 5, 10, 15, 30, 60, 120, 300, 600].find((candidate) => total / candidate <= 6) || 900;
  for (let t = 0; t <= total + 0.001; t += step) {
    const tick = document.createElement("span");
    tick.textContent = formatTick(t);
    tick.style.left = `${(t / total) * 100}%`;
    ruler.append(tick);
  }
}

function alignRuler() {
  const ruler = ui.list.parentElement?.querySelector(".wave-ruler");
  const canvas = ui.list.querySelector(".wave-canvas");
  if (!ruler || !canvas) return;
  const host = ruler.parentElement.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  // la carte a une bordure : la règle doit se caler sur le canevas, pas sur la liste
  ruler.style.marginLeft = `${Math.max(0, box.left - host.left)}px`;
  ruler.style.marginRight = `${Math.max(0, host.right - box.right)}px`;
}

function drawAllWaves() {
  const total = projectDuration();
  const ruler = ui.list.parentElement?.querySelector(".wave-ruler");
  if (ruler) renderRuler(ruler, total);

  ui.list.querySelectorAll(".wave-canvas").forEach((canvas) => {
    const track = tracks.find((t) => t.id === canvas.dataset.trackId);
    if (!track) return;
    const wave = waveCache.get(`${track.id}:${track.createdAt}`);
    if (wave) {
      drawWave(canvas, wave, track, total);
    } else {
      waveformFor(track)
        .then((computed) => { if (canvas.isConnected) drawWave(canvas, computed, track, total); })
        .catch(() => { });
    }
  });
  alignRuler();
}

function tickPlayhead() {
  const active = state === "playing" || state === "recording";
  if (!active || !ctx || playStart === null) {
    stopPlayhead();
    return;
  }
  const total = projectDuration() || 1;
  const elapsed = Math.max(0, ctx.currentTime - playStart);
  const currentMs = playBaseMs + elapsed * 1000;
  const pct = Math.min(100, (currentMs / 1000 / total) * 100);
  document.querySelectorAll(".wave-playhead").forEach((el) => {
    el.style.display = "block";
    el.style.left = `${pct.toFixed(3)}%`;
  });
  // la position affichée suit la lecture (rafraîchie 4 fois par seconde)
  if (ctx.currentTime - lastPositionPaint > 0.25) {
    lastPositionPaint = ctx.currentTime;
    positionMs = currentMs;
    updatePositionUi();
  }
  playheadRaf = requestAnimationFrame(tickPlayhead);
}

function startPlayhead(when, baseMs = 0) {
  playStart = when;
  playBaseMs = baseMs;
  lastPositionPaint = 0;
  document.querySelectorAll(".wave-playhead").forEach((el) => el.classList.remove("is-frozen"));
  if (playheadRaf) cancelAnimationFrame(playheadRaf);
  playheadRaf = requestAnimationFrame(tickPlayhead);
}

function stopPlayhead() {
  if (playheadRaf) cancelAnimationFrame(playheadRaf);
  playheadRaf = null;
  playStart = null;
  document.querySelectorAll(".wave-playhead").forEach((el) => { el.style.display = "none"; });
}

/* Curseur immobile : il marque l'endroit de la pause, donc là où démarrera la
   prochaine prise. Il doit rester visible après la pause, sinon il ne reste
   aucun repère pour enregistrer la suite. */
function paintPlayhead(ms, frozen = true) {
  const total = projectDuration() || 1;
  const pct = Math.max(0, Math.min(100, ((ms || 0) / 1000 / total) * 100));
  document.querySelectorAll(".wave-playhead").forEach((el) => {
    el.style.display = "block";
    el.style.left = `${pct.toFixed(3)}%`;
    el.classList.toggle("is-frozen", !!frozen);
  });
}

/* ------------------- placement du curseur à la souris -------------------- */

/* Cliquer (ou glisser) sur une forme d'onde place le curseur à cet endroit de
   la timeline. Pendant la lecture, la position est reprise au relâchement pour
   ne pas relancer le son à chaque pixel parcouru. */
let scrub = null;

function beginScrub(event, element) {
  if (state !== "idle" && state !== "paused" && state !== "playing") return;
  if (!projectDuration()) return;
  scrub = { wasPlaying: state === "playing", element };
  if (scrub.wasPlaying) stopPlayback(true);
  try { element.setPointerCapture(event.pointerId); } catch { }
  applyScrub(event);
}

function applyScrub(event) {
  if (!scrub) return;
  const box = scrub.element.getBoundingClientRect();
  const total = projectDuration();
  if (!box.width || !total) return;
  const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  positionMs = Math.round(ratio * total * 1000);
  updatePositionUi();
  paintPlayhead(positionMs, true);
}

function endScrub() {
  if (!scrub) return;
  const resume = scrub.wasPlaying;
  scrub = null;
  if (resume) playAll(positionMs);
  else setStatus(`Curseur placé à ${fmt(positionMs / 1000)}. « Enregistrer une piste » démarrera à cet endroit.`);
}

function renderTracks() {
  ui.list.innerHTML = "";
  ui.count.textContent = tracks.length;
  ui.export.disabled = !tracks.length || !canEdit();
  updateMuteAllButton();

  if (!tracks.length) {
    ui.list.parentElement?.querySelector(".wave-ruler")?.remove();
    ui.list.innerHTML = '<div class="empty-state"><div class="empty-icon">♫</div><strong>Aucune piste pour le moment</strong><p>Enregistre ta première voix pour commencer.</p></div>';
    return;
  }

  tracks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  // règle de temps commune : même largeur que les cartes, donc les formes
  // d'onde de toutes les pistes se lisent verticalement.
  const total = projectDuration();
  let ruler = ui.list.parentElement?.querySelector(".wave-ruler");
  if (!ruler && ui.list.parentElement) {
    ruler = document.createElement("div");
    ruler.className = "wave-ruler";
    ui.list.parentElement.insertBefore(ruler, ui.list);
  }
  if (ruler) renderRuler(ruler, total);

  tracks.forEach((track, index) => {
    const silent = typeof track.peak === "number" && track.peak < SILENT_PEAK;
    const nudgeMs = Math.round(track.nudgeMs || 0);
    const card = document.createElement("article");
    card.className = "track-card" + (track.muted ? " is-muted" : "") + (silent ? " is-silent" : "");

    const head = document.createElement("div");
    head.className = "track-head";

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = track.name || `Piste ${index + 1}`;
    const sub = document.createElement("div");
    sub.className = "track-subtitle";
    sub.textContent = `${fmt(track.duration || 0)} · WAV ${track.sampleRate || ctx?.sampleRate || 0} Hz · ${Math.round((track.blob?.size || 0) / 1024)} Ko`
      + (track.startMs > 50 ? ` · départ ${fmt(track.startMs / 1000)}` : "")
      + (nudgeMs ? ` · calage ${nudgeMs > 0 ? "+" : ""}${nudgeMs} ms` : "")
      + (silent ? " · ⚠ SILENCIEUSE (micro sans signal)" : "");
    info.append(title, sub);

    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Renommer";
    rename.addEventListener("click", async () => {
      const name = prompt("Nom de la piste", track.name);
      if (name && name.trim()) {
        track.name = name.trim();
        await storeItem("tracks", track);
        renderTracks();
      }
    });

    head.append(info, rename);

    const controls = document.createElement("div");
    controls.className = "track-controls";

    const volumeLabel = document.createElement("label");
    volumeLabel.textContent = "Volume";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = "0";
    volume.max = "1.5";
    volume.step = "0.01";
    volume.value = typeof track.volume === "number" ? track.volume : 1;
    volume.addEventListener("input", () => { storeVolume(track, Number(volume.value)); });
    volumeLabel.append(volume);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const listen = document.createElement("button");
    listen.type = "button";
    listen.textContent = "▶ Écouter";
    listen.addEventListener("click", () => playSingle(track));

    const mute = document.createElement("button");
    mute.type = "button";
    mute.textContent = track.muted ? "🔊 Réactiver" : "🔇 Muet";
    mute.title = "Couper cette piste (le volume est mémorisé)";
    mute.addEventListener("click", () => setTrackMuted(track, !track.muted));

    const nudge = document.createElement("div");
    nudge.className = "nudge";
    const earlier = document.createElement("button");
    earlier.type = "button";
    earlier.textContent = "◀ 10 ms";
    earlier.title = "Avancer cette piste de 10 ms (elle démarre plus tôt)";
    earlier.addEventListener("click", () => nudgeTrack(track, 10));
    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "10 ms ▶";
    later.title = "Retarder cette piste de 10 ms (elle démarre plus tard)";
    later.addEventListener("click", () => nudgeTrack(track, -10));
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = nudgeMs ? "↺ 0" : "0";
    reset.title = nudgeMs
      ? `Annuler le calage (${nudgeMs > 0 ? "+" : ""}${nudgeMs} ms). Les échantillons coupés au tout début ne reviennent pas.`
      : "Aucun calage en cours";
    reset.disabled = !nudgeMs;
    reset.addEventListener("click", () => resetNudge(track));
    nudge.append(earlier, later, reset);

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "⤓";
    save.title = "Télécharger cette piste en WAV";
    save.addEventListener("click", () => {
      downloadBlob(track.blob, `${safeName(ui.projectName.value)}_${safeName(track.name || `piste${index + 1}`)}.wav`);
      setStatus("Piste exportée en WAV.");
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Supprimer";
    remove.className = "delete-btn";
    remove.addEventListener("click", async () => {
      if (!confirm(`Supprimer ${track.name || "cette piste"} ? Le fichier WAV peut d'abord être téléchargé avec ⤓.`)) return;
      await deleteItem("tracks", track.id);
      bufferCache.delete(`${track.id}:${track.createdAt}`);
      tracks = tracks.filter((t) => t.id !== track.id);
      renderTracks();
      setStatus("Piste supprimée.");
    });

    actions.append(listen, mute, nudge, save, remove);
    controls.append(volumeLabel, actions);

    const waveRow = document.createElement("div");
    waveRow.className = "wave-row";
    const canvas = document.createElement("canvas");
    canvas.className = "wave-canvas";
    canvas.dataset.trackId = track.id;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Forme d'onde de ${track.name || "la piste"} sur l'échelle du projet`);
    canvas.title = track.muted
      ? "Piste muette : la forme d'onde reste affichée comme repère de synchronisation."
      : "Forme d'onde sur l'échelle du projet — repère pour synchroniser les autres voix.";
    const wavePlayhead = document.createElement("div");
    wavePlayhead.className = "wave-playhead";
    waveRow.append(canvas, wavePlayhead);
    waveRow.title = "Clique ou glisse ici pour placer le curseur à cet endroit";
    waveRow.addEventListener("pointerdown", (event) => beginScrub(event, waveRow));
    waveRow.addEventListener("pointermove", (event) => { if (scrub) applyScrub(event); });
    waveRow.addEventListener("pointerup", endScrub);
    waveRow.addEventListener("pointercancel", endScrub);

    card.append(head, waveRow, controls);
    ui.list.append(card);

    waveformFor(track)
      .then((wave) => { if (canvas.isConnected) drawWave(canvas, wave, track, total); })
      .catch((error) => console.warn("Forme d'onde indisponible", error));
  });

  alignRuler();
  updatePositionUi();
  // la liste est reconstruite : le curseur doit être redessiné à sa position
  if (state !== "playing" && state !== "recording") paintPlayhead(positionMs, true);
}

/* --------------------------- recalage d'une piste ----------------------- */

/* Convention de signe UNIQUE dans toute l'application, identique au champ
   « Décalage matériel » : POSITIF = la piste est avancée (elle démarre plus tôt),
   NÉGATIF = la piste est retardée. Avancer revient à couper des échantillons au
   début ; retarder revient à en ajouter. */
async function shiftTrack(track, advanceMs) {
  if (!advanceMs) return;
  const pcm = await readPcm16(track.blob);
  const samples = Math.round((advanceMs / 1000) * pcm.sampleRate);
  if (!samples) return;

  let out;
  if (samples > 0) {
    const cut = Math.min(samples, pcm.samples.length);
    out = pcm.samples.slice(cut);
  } else {
    out = new Int16Array(pcm.samples.length - samples);
    out.set(pcm.samples, -samples);
  }

  track.blob = wavFromInt16(out, pcm.sampleRate, 1);
  track.duration = out.length / pcm.sampleRate;
  track.nudgeMs = Math.round((track.nudgeMs || 0) + advanceMs);
  await storeItem("tracks", track);
  bufferCache.delete(`${track.id}:${track.createdAt}`);
  waveCache.delete(`${track.id}:${track.createdAt}`);
  renderTracks();
}

function signed(ms) {
  return `${ms > 0 ? "+" : ""}${ms} ms`;
}

async function nudgeTrack(track, advanceMs) {
  if (!canEdit()) { setStatus("Arrête la lecture ou l'enregistrement pour recaler une piste."); return; }
  try {
    await shiftTrack(track, advanceMs);
    const action = advanceMs > 0 ? `avancée de ${advanceMs} ms` : `retardée de ${-advanceMs} ms`;
    setStatus(`${track.name || "Piste"} ${action} — calage total ${signed(track.nudgeMs)}.`);
  } catch (error) {
    setStatus(`Recalage impossible : ${error.message}`);
  }
}

async function resetNudge(track) {
  if (!canEdit()) { setStatus("Arrête la lecture ou l'enregistrement pour recaler une piste."); return; }
  if (!track.nudgeMs) return;
  try {
    const total = track.nudgeMs;
    await shiftTrack(track, -total);
    track.nudgeMs = 0;
    await storeItem("tracks", track);
    renderTracks();
    setStatus(`Calage de ${track.name || "la piste"} remis à 0 ms (${signed(total)} annulé).`);
  } catch (error) {
    setStatus(`Remise à zéro impossible : ${error.message}`);
  }
}

/* Le sens du calage a été inversé pour coller au champ « Décalage matériel » :
   les pistes recalées avec l'ancienne convention doivent être retournées une
   fois, sinon leur étiquette ment sur le sens du décalage. */
async function migrateNudgeSign() {
  if (localStorage.getItem("voicelayer-nudge-sign-v2")) return 0;
  let changed = 0;
  for (const track of tracks) {
    if (typeof track.nudgeMs === "number" && track.nudgeMs !== 0) {
      track.nudgeMs = -track.nudgeMs;
      await storeItem("tracks", track);
      changed++;
    }
  }
  localStorage.setItem("voicelayer-nudge-sign-v2", "1");
  return changed;
}

/* ------------------------------ export mix ------------------------------ */

async function exportMix() {
  if (!tracks.length || !canEdit()) return;

  ui.export.disabled = true;
  setStatus("Préparation du mixage WAV…");

  try {
    const parts = [];
    for (const track of tracks) {
      const pcm = await readPcm16(track.blob);
      parts.push({
        pcm,
        startMs: track.startMs || 0,
        gain: track.muted ? 0 : (typeof track.volume === "number" ? track.volume : 1),
      });
    }

    const sampleRate = parts[0].pcm.sampleRate;
    const offsetOf = (part) => Math.max(0, Math.round((part.startMs / 1000) * sampleRate));
    // le mix doit couvrir la piste qui finit le plus tard, départs compris
    const length = Math.max(...parts.map((part) => offsetOf(part) + part.pcm.samples.length));
    const mix = new Float32Array(length);

    for (const part of parts) {
      if (!part.gain) continue;
      const s = part.pcm.samples;
      const off = offsetOf(part);
      for (let i = 0; i < s.length && off + i < length; i++) mix[off + i] += (s[i] / 32768) * part.gain;
    }

    let peak = 0;
    for (let i = 0; i < length; i++) {
      const a = Math.abs(mix[i]);
      if (a > peak) peak = a;
    }
    if (peak > 0.98) {
      const factor = 0.98 / peak;
      for (let i = 0; i < length; i++) mix[i] *= factor;
    }

    const wav = wavFromInt16(floatToInt16(mix), sampleRate, 2);
    downloadBlob(wav, `${safeName(ui.projectName.value)}_mix.wav`);
    setStatus(`Export WAV terminé : ${Math.round(wav.size / 1024 / 1024 * 10) / 10} Mo. Écoute-le avant de l'importer dans Suno.`);
  } catch (error) {
    setStatus(`Erreur pendant l'export : ${error.message}`);
  } finally {
    ui.export.disabled = !tracks.length || !canEdit();
  }
}

/* ------------------------- import et sauvegarde ------------------------- */

async function importAudioFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  await ensureCtx();
  let imported = 0;

  for (const file of files) {
    if (tracks.length >= MAX_TRACKS) {
      setStatus(`Limite de ${MAX_TRACKS} pistes atteinte : les fichiers restants sont ignorés.`);
      break;
    }
    try {
      setStatus(`Import de ${file.name}…`);
      const arrayBuffer = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

      // On ramène tout à la fréquence du projet pour que le mix reste une
      // somme d'échantillons alignés.
      const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * ctx.sampleRate)), ctx.sampleRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      const pcm = floatToInt16(rendered.getChannelData(0));

      const track = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 60),
        blob: wavFromInt16(pcm, ctx.sampleRate, 1),
        sampleRate: ctx.sampleRate,
        duration: pcm.length / ctx.sampleRate,
        peak: peakOf(pcm),
        volume: 1,
        muted: false,
        createdAt: Date.now(),
      };

      await storeItem("tracks", track);
      tracks.push(track);
      imported++;
    } catch (error) {
      setStatus(`Import impossible pour ${file.name} : ${error.message}`);
    }
  }

  renderTracks();
  if (imported) setStatus(`${imported} fichier(s) importé(s). Sers-t'en comme accompagnement pour une nouvelle prise.`);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function saveProject() {
  if (!tracks.length) { setStatus("Aucune piste à sauvegarder."); return; }
  try {
    setStatus("Préparation du fichier de sauvegarde…");
    const payload = {
      app: "voicelayer",
      version: 1,
      savedAt: new Date().toISOString(),
      projectName: ui.projectName.value,
      tracks: [],
    };

    for (const track of tracks) {
      payload.tracks.push({
        id: track.id,
        name: track.name,
        volume: track.volume,
        muted: !!track.muted,
        createdAt: track.createdAt,
        sampleRate: track.sampleRate,
        duration: track.duration,
        startMs: track.startMs || 0,
        nudgeMs: track.nudgeMs || 0,
        peak: typeof track.peak === "number" ? track.peak : undefined,
        wav: arrayBufferToBase64(await track.blob.arrayBuffer()),
      });
    }

    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: "application/json" });
    downloadBlob(blob, `${safeName(ui.projectName.value)}_voicelayer.json`);
    setStatus(`Projet sauvegardé (${Math.round(blob.size / 1024 / 1024 * 10) / 10} Mo). Range ce fichier ailleurs que dans le navigateur.`);
  } catch (error) {
    setStatus(`Sauvegarde impossible : ${error.message}`);
  }
}

async function loadProjectFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.app !== "voicelayer" || !Array.isArray(data.tracks)) throw new Error("ce fichier n'est pas une sauvegarde VoiceLayer");

    if (tracks.length && !confirm("Remplacer les pistes actuellement présentes par celles du fichier ? Les pistes actuelles seront supprimées de cet appareil.")) return;

    for (const track of tracks) await deleteItem("tracks", track.id);
    tracks = [];
    bufferCache.clear();

    for (const item of data.tracks) {
      const buffer = base64ToArrayBuffer(item.wav);
      const track = {
        id: item.id || crypto.randomUUID(),
        name: item.name || "Piste",
        blob: new Blob([buffer], { type: "audio/wav" }),
        sampleRate: item.sampleRate || ctx.sampleRate,
        duration: item.duration || 0,
        startMs: Math.round(item.startMs || 0),
        nudgeMs: Math.round(item.nudgeMs || 0),
        peak: typeof item.peak === "number" ? item.peak : undefined,
        volume: typeof item.volume === "number" ? item.volume : 1,
        muted: !!item.muted,
        createdAt: item.createdAt || Date.now(),
      };
      await storeItem("tracks", track);
      tracks.push(track);
    }

    ui.projectName.value = data.projectName || "Projet restauré";
    renderTracks();
    setStatus(`Projet restauré : ${tracks.length} piste(s).`);
  } catch (error) {
    setStatus(`Chargement impossible : ${error.message}`);
  }
}

/* ----------------------------- nouveau projet --------------------------- */

async function clearProject() {
  if (!tracks.length) { setStatus("Le projet est déjà vide."); return; }
  if (!confirm("Créer un nouveau projet ? Les pistes actuelles seront supprimées de cet appareil. Télécharge-les (⤓) ou sauvegarde le projet avant.")) return;

  for (const track of tracks) await deleteItem("tracks", track.id);
  tracks = [];
  bufferCache.clear();
  stopPlayback();
  ui.projectName.value = "Nouveau projet";
  ui.timer.textContent = "00:00";
  renderTracks();
  setStatus("Nouveau projet prêt.");
}

/* -------------------------- migration V0.2 -> V1 ------------------------ */
/* Une piste de la V0.2 est un Blob WebM/Opus : illisible par le moteur PCM.
   On la convertit en WAV une fois, sans jamais supprimer l'original avant
   que la conversion ait réussi. */
async function migrateTracks() {
  const legacy = tracks.filter((t) => !t.blob || t.blob.type !== "audio/wav");
  if (!legacy.length) return 0;

  await ensureCtx();
  let converted = 0;

  for (const track of legacy) {
    try {
      const decoded = await ctx.decodeAudioData(await track.blob.arrayBuffer());
      const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * ctx.sampleRate)), ctx.sampleRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      const pcm = floatToInt16(rendered.getChannelData(0));

      track.blob = wavFromInt16(pcm, ctx.sampleRate, 1);
      track.sampleRate = ctx.sampleRate;
      track.duration = pcm.length / ctx.sampleRate;
      track.peak = peakOf(pcm);
      if (typeof track.volume !== "number") track.volume = 1;
      track.muted = !!track.muted;
      await storeItem("tracks", track);
      converted++;
    } catch (error) {
      console.warn("Migration impossible pour la piste", track.id, error);
    }
  }
  return converted;
}

/* -------------------------------- init ---------------------------------- */

/* Les pistes restaurées ou importées peuvent ne pas avoir de niveau mesuré :
   on le calcule une fois pour que l'écran distingue une prise réelle d'une
   prise silencieuse, y compris sur les anciennes prises. */
async function ensurePeaks() {
  const missing = tracks.filter((t) => typeof t.peak !== "number");
  for (const track of missing) {
    try {
      const pcm = await readPcm16(track.blob);
      track.peak = peakOf(pcm.samples);
      await storeItem("tracks", track);
    } catch {
      /* piste illisible : on la laisse affichée telle quelle */
    }
  }
  return missing.length;
}

ui.record.addEventListener("click", startRecording);
ui.stop.addEventListener("click", stopRecording);
ui.play.addEventListener("click", () => {
  // un seul bouton : il lance, met en pause et reprend exactement où on s'est arrêté
  if (state === "playing") pausePlayback();
  else if (state === "paused" || state === "idle") playAll(positionMs);
});
ui.toStart.addEventListener("click", backToStart);
ui.export.addEventListener("click", exportMix);
ui.newProject.addEventListener("click", clearProject);
ui.testMic.addEventListener("click", toggleMicTest);
ui.monitorBtn.addEventListener("click", toggleMonitoring);
ui.monitorVolume.addEventListener("input", applyMonitorGain);

// le redessin au redimensionnement doit passer par les formes d'onde déjà
// calculées, sans reconstruire la liste (et sans perdre le focus des curseurs).
let waveResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(waveResizeTimer);
  waveResizeTimer = setTimeout(drawAllWaves, 160);
});
ui.refreshMics.addEventListener("click", refreshMicrophones);
ui.muteAll.addEventListener("click", () => setMasterMuted(!allMuted));

ui.micSelect.addEventListener("change", () => {
  localStorage.setItem(MIC_PREF_KEY, ui.micSelect.value);
  loadOffsetForCurrentMic();
  ui.micState.textContent = "À tester";
  ui.micState.className = "mic-state";
  setStatus("Microphone sélectionné. Lance un test pour vérifier le niveau.");
});

ui.offset.addEventListener("change", () => {
  localStorage.setItem(offsetKey(), String(currentOffsetMs()));
  setStatus(`Décalage matériel mémorisé : ${currentOffsetMs()} ms pour ce micro.`);
});

ui.importBtn.addEventListener("click", () => ui.importInput.click());
ui.importInput.addEventListener("change", async () => {
  await importAudioFiles(ui.importInput.files);
  ui.importInput.value = "";
});

ui.saveProject.addEventListener("click", saveProject);
ui.loadProject.addEventListener("click", () => ui.projectInput.click());
ui.projectInput.addEventListener("change", async () => {
  await loadProjectFile(ui.projectInput.files[0]);
  ui.projectInput.value = "";
});

// Le Service Worker de la V0.2 n'a plus de raison d'exister : s'il en reste un
// enregistré, il ressert l'ancien app.js et reproduit le faux mystère du bouton
// mute invisible. On le désinscrit une bonne fois.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => { });
}

(async function init() {
  try {
    db = await openDatabase();
    tracks = await getAll("tracks");
    if (!tracks.length) ui.list.innerHTML = '<div class="empty-state"><div class="empty-icon">♫</div><strong>Aucune piste pour le moment</strong><p>Enregistre ta première voix pour commencer.</p></div>';

    renderTracks();
    await refreshMicrophones();
    await ensureCtx();
    await initRecorder();

    const converted = await migrateTracks();
    if (converted) {
      renderTracks();
      setStatus(`${converted} piste(s) de l'ancienne version converties en WAV. Elles restent en place.`);
    } else if (!tracks.length) {
      setStatus("Prêt. Choisis ton microphone, teste-le, puis enregistre une première piste.");
    }

    await ensurePeaks();
    await migrateNudgeSign();
    renderTracks();
    updatePositionUi();

    ui.engine.textContent = `Moteur PCM ${ctx.sampleRate} Hz`;
  } catch (error) {
    setStatus(`Erreur d'initialisation : ${error.message}`);
  }
})();
