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
  record: $("recordBtn"), stop: $("stopBtn"), play: $("playBtn"), timer: $("timer"), status: $("statusMessage"),
  list: $("tracks"), count: $("trackCount"), export: $("exportBtn"), muteAll: $("muteAllBtn"), mixHint: $("mixHint"),
};

let ctx = null;
let micStream = null, micSource = null, analyser = null, meterFrame = null, meterData = null;
let recorderNode = null, silentGain = null, pendingCapture = null;
let testActive = false;

let tracks = [];
let allMuted = localStorage.getItem(MUTE_PREF_KEY) === "true";
let state = "idle";                 // idle | countdown | recording | playing
let captureStartAt = 0, captureFirstTime = -1;
let playSources = [], playGains = new Map();
let bufferCache = new Map();
let timerInterval = null;
let countdownInterval = null;

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
    outputChannelCount: [1],
  });

  // Un noeud sans sortie connectée n'est pas tiré par le graphe audio :
  // on le branche sur un gain nul pour garantir l'appel de process().
  silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  recorderNode.connect(silentGain).connect(ctx.destination);

  recorderNode.port.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "done" && pendingCapture) {
      const pending = pendingCapture;
      pendingCapture = null;
      pending.resolve(data);
    }
  };
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
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micSource) { try { micSource.disconnect(); } catch { } micSource = null; }

  micStream = await navigator.mediaDevices.getUserMedia(micConstraints());
  localStorage.setItem(MIC_PREF_KEY, ui.micSelect.value || "");

  micSource = ctx.createMediaStreamSource(micStream);
  micSource.connect(recorderNode);

  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  micSource.connect(analyser);
  meterData = new Uint8Array(analyser.fftSize);

  return micStream;
}

function startMeter() {
  const draw = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(meterData);
    let sum = 0;
    for (let i = 0; i < meterData.length; i++) {
      const x = (meterData[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / meterData.length);
    ui.meter.style.width = `${Math.min(100, Math.max(0, rms * 450))}%`;
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  ui.meter.style.width = "0%";
}

function releaseMic() {
  stopMeter();
  if (micSource) { try { micSource.disconnect(); } catch { } micSource = null; }
  analyser = null;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
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

function stopPlayback() {
  playSources.forEach((s) => { try { s.stop(); } catch { } });
  playSources = [];
  playGains.clear();
  if (state === "playing") state = "idle";
  ui.play.textContent = "▶ Tout écouter";
}

async function scheduleTracks(items, when) {
  const sources = [];
  for (const item of items) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = item.buffer;
    gain.gain.value = item.gain;
    source.connect(gain).connect(ctx.destination);
    if (when !== undefined) source.start(when);
    else source.start();
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

async function playAll() {
  if (!tracks.length) return;
  try {
    await ensureCtx();
    stopPlayback();
    setStatus("Préparation de la lecture…");

    const items = [];
    for (const track of tracks) {
      items.push({ id: track.id, buffer: await bufferFor(track), gain: gainFor(track) });
    }

    const startAt = ctx.currentTime + 0.1;
    const sources = await scheduleTracks(items, startAt);
    state = "playing";
    ui.play.textContent = "■ Arrêter l'écoute";
    setStatus(allMuted
      ? "Lecture lancée, mais TOUTES LES PISTES SONT MUETTES : tu n'entendras rien. Clique « Réactiver toutes les pistes »."
      : "Lecture de toutes les pistes.");

    let ended = 0;
    sources.forEach((source) => {
      source.addEventListener("ended", () => {
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
    stopPlayback();
    const buffer = await bufferFor(track);
    await scheduleTracks([{ id: track.id, buffer, gain: gainFor(track) }], ctx.currentTime + 0.05);
    state = "playing";
    ui.play.textContent = "■ Arrêter l'écoute";
    setStatus(`Lecture : ${track.name || "piste"}.`);
    const source = playSources[0];
    source.addEventListener("ended", () => { if (state === "playing") stopPlayback(); }, { once: true });
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
}

async function startRecording() {
  if (state !== "idle") return;

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
      backing.push({ id: track.id, buffer: await bufferFor(track), gain: gainFor(track) });
    }

    await armMic();

    state = "countdown";
    setTransportLocked(true);
    stopPlayback();
    stopMeter();
    ui.timer.textContent = "03";
    setStatus("Prépare-toi… démarrage dans 3 secondes.");

    let count = 3;
    countdownInterval = setInterval(async () => {
      count--;
      if (count > 0) { ui.timer.textContent = `0${count}`; return; }
      clearInterval(countdownInterval);
      countdownInterval = null;
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

  pendingCapture = null;
  recorderNode.port.postMessage({ cmd: "start" });

  if (backing.length) await scheduleTracks(backing, startAt);

  state = "recording";
  startMeter();
  ui.micState.textContent = "Enregistrement";
  ui.micState.className = "mic-state active";
  setStatus(backing.length
    ? "Enregistrement en cours… chante sur les pistes déjà enregistrées."
    : "Enregistrement en cours…");

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
  stopPlayback();

  const done = await new Promise((resolve) => {
    pendingCapture = { resolve };
    recorderNode.port.postMessage({ cmd: "stop" });
  });

  await finalizeTake(done);
}

async function finalizeTake(data) {
  const sampleRate = ctx.sampleRate;

  try {
    let total = 0;
    for (const chunk of data.chunks || []) total += chunk.byteLength / 2;
    if (!total) throw new Error("aucun échantillon capturé");

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
    const duration = kept.length / sampleRate;

    if (duration < MIN_TAKE) throw new Error("prise trop courte, rien n'a été conservé");

    const peak = peakOf(kept);

    const track = {
      id: crypto.randomUUID(),
      name: `Piste ${tracks.length + 1}`,
      blob: wavFromInt16(kept, sampleRate, 1),
      sampleRate,
      duration,
      peak,
      volume: 1,
      muted: false,
      createdAt: Date.now(),
    };

    await storeItem("tracks", track);
    tracks.push(track);
    renderTracks();

    ui.timer.textContent = fmt(duration);

    if (peak < SILENT_PEAK) {
      ui.micState.textContent = "Micro muet ?";
      ui.micState.className = "mic-state error";
      setStatus(`Prise enregistrée mais SILENCIEUSE : le micro n'a capté aucun son sur ${fmt(duration)}. Vérifie le micro sélectionné, puis le niveau d'entrée dans Windows (Paramètres › Système › Son › Entrée). Clique ⤓ pour garder quand même le fichier.`);
    } else {
      ui.micState.textContent = "Prêt";
      ui.micState.className = "mic-state";
      setStatus(`Piste enregistrée : ${fmt(duration)}, niveau max ${Math.round(peak * 100)} % (${Math.round(track.blob.size / 1024)} Ko).`);
    }
  } catch (error) {
    setStatus(`Piste non enregistrée : ${error.message}`);
  } finally {
    releaseMic();
    state = "idle";
    setTransportLocked(false);
    if (!tracks.length) ui.timer.textContent = "00:00";
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

function renderTracks() {
  ui.list.innerHTML = "";
  ui.count.textContent = tracks.length;
  ui.export.disabled = !tracks.length || state !== "idle";
  updateMuteAllButton();

  if (!tracks.length) {
    ui.list.innerHTML = '<div class="empty-state"><div class="empty-icon">♫</div><strong>Aucune piste pour le moment</strong><p>Enregistre ta première voix pour commencer.</p></div>';
    return;
  }

  tracks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  tracks.forEach((track, index) => {
    const silent = typeof track.peak === "number" && track.peak < SILENT_PEAK;
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
    earlier.title = "Avancer cette piste de 10 ms";
    earlier.addEventListener("click", () => nudgeTrack(track, -10));
    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "10 ms ▶";
    later.title = "Retarder cette piste de 10 ms";
    later.addEventListener("click", () => nudgeTrack(track, 10));
    nudge.append(earlier, later);

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
    card.append(head, controls);
    ui.list.append(card);
  });
}

/* --------------------------- recalage d'une piste ----------------------- */

async function nudgeTrack(track, ms) {
  if (state !== "idle") { setStatus("Arrête la lecture ou l'enregistrement pour recaler une piste."); return; }
  try {
    const pcm = await readPcm16(track.blob);
    const shift = Math.round((ms / 1000) * pcm.sampleRate);
    let out;

    if (shift > 0) {
      out = new Int16Array(pcm.samples.length + shift);
      out.set(pcm.samples, shift);
    } else {
      const cut = Math.min(-shift, pcm.samples.length);
      out = pcm.samples.slice(cut);
    }

    track.blob = wavFromInt16(out, pcm.sampleRate, 1);
    track.duration = out.length / pcm.sampleRate;
    await storeItem("tracks", track);
    bufferCache.delete(`${track.id}:${track.createdAt}`);
    renderTracks();
    setStatus(`${track.name || "Piste"} recalée de ${ms > 0 ? "+" : ""}${ms} ms.`);
  } catch (error) {
    setStatus(`Recalage impossible : ${error.message}`);
  }
}

/* ------------------------------ export mix ------------------------------ */

async function exportMix() {
  if (!tracks.length || state !== "idle") return;

  ui.export.disabled = true;
  setStatus("Préparation du mixage WAV…");

  try {
    const parts = [];
    for (const track of tracks) {
      const pcm = await readPcm16(track.blob);
      parts.push({ pcm, gain: track.muted ? 0 : (typeof track.volume === "number" ? track.volume : 1) });
    }

    const sampleRate = parts[0].pcm.sampleRate;
    const length = Math.max(...parts.map((p) => p.pcm.samples.length));
    const mix = new Float32Array(length);

    for (const part of parts) {
      if (!part.gain) continue;
      const s = part.pcm.samples;
      for (let i = 0; i < s.length; i++) mix[i] += (s[i] / 32768) * part.gain;
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
    ui.export.disabled = !tracks.length || state !== "idle";
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
  if (state === "playing") { stopPlayback(); setStatus("Lecture arrêtée."); }
  else if (state === "idle") playAll();
});
ui.export.addEventListener("click", exportMix);
ui.newProject.addEventListener("click", clearProject);
ui.testMic.addEventListener("click", toggleMicTest);
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
    renderTracks();

    ui.engine.textContent = `Moteur PCM ${ctx.sampleRate} Hz`;
  } catch (error) {
    setStatus(`Erreur d'initialisation : ${error.message}`);
  }
})();
