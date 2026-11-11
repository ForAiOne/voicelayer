/* Test de bout en bout de VoiceLayer V1, avec le faux périphérique audio de Chrome.
   Vérifie : init du moteur, jauge micro, prise réelle, alignement (durée), export WAV,
   mute général sans effet sur l'export, recalage d'une piste. */

const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { ensureTone } = require("./tone");

const CHROME = "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const URL_APP = process.env.APP_URL || "http://127.0.0.1:8099/index.html";
const OUT = "/root/projets/voicelayer/test/out";

function parseWav(file) {
  const b = fs.readFileSync(file);
  const tag = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("pas un WAV");
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = tag(pos);
    const size = b.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = { channels: b.readUInt16LE(pos + 10), sampleRate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    } else if (id === "data") { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  const frames = dataLen / (fmt.channels * (fmt.bits / 8));
  let peak = 0, sum = 0, n = 0;
  for (let i = 0; i < frames; i++) {
    const v = b.readInt16LE(dataOff + i * fmt.channels * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v; n++;
  }
  return { ...fmt, frames, duration: frames / fmt.sampleRate, peak, rms: Math.sqrt(sum / Math.max(1, n)), bytes: b.length };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${ensureTone()}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--mute-audio",
    ],
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text()); });

  await page.goto(URL_APP, { waitUntil: "load" });

  // 1. le moteur démarre
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });
  const engine = await page.textContent("#enginePill");
  check("moteur audio démarré", /Moteur PCM \d+ Hz/.test(engine), engine);

  const sr = await page.evaluate(() => Number(document.getElementById("enginePill").textContent.match(/(\d+) Hz/)[1]));
  check("fréquence d'échantillonnage connue", sr >= 8000, sr + " Hz");

  // 1 bis. retour casque : un bouton explicite, jamais actif au départ
  const defMon = await page.evaluate(() => ({
    monitoring,
    label: document.getElementById("monitorBtn").textContent,
    pressed: document.getElementById("monitorBtn").getAttribute("aria-pressed"),
    volumeHidden: document.getElementById("monitorVolume").parentElement.hidden,
  }));
  check("retour casque désactivé par défaut",
    defMon.monitoring === false && defMon.pressed === "false" && defMon.volumeHidden === true,
    JSON.stringify(defMon));
  check("le bouton annonce clairement l'activation", /Activer le retour casque/.test(defMon.label), defMon.label);

  // 2. jauge du micro — le faux périphérique de Chrome émet un bip périodique,
  // donc on échantillonne plusieurs secondes et on garde le maximum observé.
  await page.click("#testMicBtn");
  let meterVal = 0, meterSeen = "0%";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    const w = await page.evaluate(() => document.getElementById("meterFill").style.width);
    const v = parseFloat(w) || 0;
    if (v > meterVal) { meterVal = v; meterSeen = w; }
    if (meterVal > 5) break;
  }
  check("la jauge micro réagit au signal", meterVal > 1, `max observé ${meterSeen}`);
  await page.click("#testMicBtn");
  await page.waitForTimeout(300);

  // 2 bis. retour casque : le micro est renvoyé vers la sortie, en parallèle du
  // chemin d'enregistrement.
  page.on("dialog", (d) => d.accept());
  await page.click("#monitorBtn");
  await page.waitForTimeout(700);
  const monOn = await page.evaluate(() => ({
    monitoring,
    gain: monitorGain ? monitorGain.gain.value : null,
    pressed: document.getElementById("monitorBtn").getAttribute("aria-pressed"),
    volumeVisible: !document.getElementById("monitorVolume").parentElement.hidden,
  }));
  check("retour casque : gain ouvert", monOn.monitoring === true && monOn.gain > 0.5, `gain ${monOn.gain}`);
  check("retour casque : bouton et volume affichés", monOn.pressed === "true" && monOn.volumeVisible, JSON.stringify(monOn));

  // 3. annulation pendant le décompte : aucune piste, retour à l'état prêt
  await page.click("#recordBtn");
  await page.waitForTimeout(1200);
  await page.click("#stopBtn");
  await page.waitForTimeout(2500); // au-delà du décompte : rien ne doit démarrer tout seul
  const afterCancel = await page.evaluate(() => ({
    status: document.getElementById("statusMessage").textContent,
    cards: document.querySelectorAll(".track-card").length,
    recordDisabled: document.getElementById("recordBtn").disabled,
  }));
  check("annulation du décompte sans piste fantôme",
    afterCancel.cards === 0 && !afterCancel.recordDisabled && /annulé/i.test(afterCancel.status),
    `${afterCancel.cards} piste(s) · ${afterCancel.status}`);

  // 4. enregistrement réel
  await page.click("#recordBtn");
  await page.waitForFunction(() => document.getElementById("micState").textContent === "Enregistrement", null, { timeout: 10000 });
  const recStart = Date.now();
  await page.waitForTimeout(1200);
  const readout = await page.textContent("#levelReadout");
  const micInfo = await page.textContent("#micInfo");
  await page.waitForTimeout(1800);
  await page.click("#stopBtn");
  const wall = (Date.now() - recStart) / 1000;

  // L'instrument doit montrer les deux niveaux : celui du micro et celui que
  // l'enregistreur reçoit réellement. C'est ce qui sépare « micro muet » de
  // « enregistreur qui ne reçoit rien ».
  const micPct = Number((readout.match(/micro \(max\) (\d+) %/) || [])[1]);
  const recPct = Number((readout.match(/enregistré \(max\) (\d+) %/) || [])[1]);
  check("niveau du micro affiché pendant la prise", micPct > 0, readout);
  check("niveau reçu par l'enregistreur affiché", recPct > 0, readout);
  check("micro réellement ouvert nommé", /Micro réellement ouvert/.test(micInfo), micInfo || "(vide)");

  await page.waitForSelector(".track-card", { timeout: 15000 });
  check("une piste apparaît dans la liste", true, `temps réel ${wall.toFixed(2)} s`);

  const trackData = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res, rej) => { const r = db.transaction("tracks").objectStore("tracks").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const t = all[0];
    const bytes = new Uint8Array(await t.blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(s), type: t.blob.type, duration: t.duration, sampleRate: t.sampleRate, count: all.length, name: t.name };
  });

  const wavPath = path.join(OUT, "prise.wav");
  fs.writeFileSync(wavPath, Buffer.from(trackData.b64, "base64"));
  const wav = parseWav(wavPath);

  check("piste stockée en audio/wav", trackData.type === "audio/wav", trackData.type);
  check("fréquence de la piste = celle du contexte", wav.sampleRate === sr, `${wav.sampleRate} vs ${sr}`);
  check("la piste contient du signal", wav.rms > 0.005, `rms ${wav.rms.toFixed(4)} crête ${wav.peak.toFixed(3)}`);
  // Alignement : la prise commence à startAt, soit 250 ms APRÈS le passage à
  // l'état « Enregistrement » (PREROLL). Cette marge doit donc être retirée de
  // la durée mesurée. Si le retrait était absent ou faux de 250 ms, la durée
  // observée s'écarterait de ~250 ms.
  const PREROLL = 0.25;
  const expected = wall - PREROLL;
  const delta = Math.abs(wav.duration - expected);
  check("durée alignée sur le temps réel (±150 ms)", delta < 0.15,
    `${wav.duration.toFixed(3)} s vs ${expected.toFixed(3)} s attendu (écart ${(delta * 1000).toFixed(0)} ms)`);

  // 3 bis. l'application doit annoncer le niveau capté, et ne pas marquer
  // cette prise comme silencieuse (le faux micro émet un bip).
  const recStatus = await page.textContent("#statusMessage");
  const subtitle = await page.textContent(".track-subtitle");
  check("niveau capté annoncé après la prise", /niveau max \d+ %/.test(recStatus), recStatus);
  check("prise non marquée silencieuse", !/SILENCIEUSE/.test(subtitle) && !/SILENCIEUSE/.test(recStatus), subtitle);

  // 3 ter. couper le retour casque : le gain doit retomber à zéro
  await page.click("#monitorBtn");
  await page.waitForTimeout(500);
  const monOff = await page.evaluate(() => ({
    monitoring,
    gain: monitorGain ? monitorGain.gain.value : null,
    pressed: document.getElementById("monitorBtn").getAttribute("aria-pressed"),
  }));
  check("retour casque : coupé proprement", monOff.monitoring === false && monOff.gain < 0.05 && monOff.pressed === "false", JSON.stringify(monOff));

  // 4. export du mix
  const dl = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#exportBtn"),
  ]);
  const mixPath = path.join(OUT, "mix.wav");
  await dl[0].saveAs(mixPath);
  const mix = parseWav(mixPath);
  check("export WAV produit un fichier", mix.bytes > 44, `${(mix.bytes / 1024).toFixed(0)} Ko`);
  check("export en stéréo 16 bits", mix.channels === 2 && mix.bits === 16, `${mix.channels} canaux / ${mix.bits} bits`);
  check("export contient le signal de la piste", mix.rms > 0.005, `rms ${mix.rms.toFixed(4)}`);

  // 5. mute général : ne doit PAS rendre l'export muet (régression de la V0.2)
  await page.click("#muteAllBtn");
  await page.waitForTimeout(300);
  const hint = await page.textContent("#mixHint");
  check("avertissement de mute général affiché", /muettes/i.test(hint), hint);

  await page.click("#playBtn");
  await page.waitForTimeout(500);
  const playStatus = await page.textContent("#statusMessage");
  check("la lecture prévient qu'elle sera muette", /MUETTES/.test(playStatus), playStatus);
  await page.click("#playBtn");
  await page.waitForTimeout(400);
  const dl2 = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#exportBtn"),
  ]);
  const mixMutedPath = path.join(OUT, "mix-mute-general.wav");
  await dl2[0].saveAs(mixMutedPath);
  const mixMuted = parseWav(mixMutedPath);
  check("mute général sans effet sur l'export", mixMuted.peak > 0.01, `crête ${mixMuted.peak.toFixed(3)}`);
  await page.click("#muteAllBtn"); // on réactive

  // 6. mute d'une piste : l'export doit devenir silencieux
  await page.click(".track-actions button:nth-child(2)"); // bouton Muet de la piste 1
  await page.waitForTimeout(300);
  const dl3 = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#exportBtn"),
  ]);
  const mixTrackMutedPath = path.join(OUT, "mix-piste-muette.wav");
  await dl3[0].saveAs(mixTrackMutedPath);
  const mixTrackMuted = parseWav(mixTrackMutedPath);
  check("mute d'une piste respecté dans l'export", mixTrackMuted.peak < 0.01, `crête ${mixTrackMuted.peak.toFixed(4)}`);
  await page.click(".track-actions button:nth-child(2)"); // on réactive

  // 7. recalage : AVANCER de 10 ms (cas réel — la voix arrive en retard sur
  // l'accompagnement). Convention : positif = avancé, comme le champ matériel.
  const before = await page.evaluate(() => document.querySelector(".track-subtitle").textContent);
  await page.click(".nudge button:nth-child(1)");
  await page.waitForTimeout(900);
  const after = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res, rej) => { const r = db.transaction("tracks").objectStore("tracks").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return all[0].duration;
  });
  check("avancer de 10 ms raccourcit la piste de 10 ms", Math.abs(after - (wav.duration - 0.01)) < 0.002, `${before} → ${after.toFixed(3)} s`);

  // 7 bis. le calage doit être visible en permanence sur la piste
  const nudgeLabel = await page.textContent(".track-subtitle");
  const nudgeTotal = await page.evaluate(() => tracks[0].nudgeMs);
  check("calage cumulé affiché, signe positif = avancé", /calage \+10 ms/.test(nudgeLabel) && nudgeTotal === 10, nudgeLabel);

  // 7 ter. retarder de 10 ms annule l'avance (même convention)
  await page.click(".nudge button:nth-child(2)");
  await page.waitForTimeout(900);
  const afterLater = await page.evaluate(() => ({ nudgeMs: tracks[0].nudgeMs, label: document.querySelector(".track-subtitle").textContent }));
  check("retarder annule l'avance, retour à 0", afterLater.nudgeMs === 0 && !/calage/.test(afterLater.label), `${afterLater.nudgeMs} · ${afterLater.label}`);

  // 7 quater. avancer de 20 ms puis remise à zéro (le cas mesuré par l'utilisateur)
  await page.click(".nudge button:nth-child(1)");
  await page.waitForTimeout(600);
  await page.click(".nudge button:nth-child(1)");
  await page.waitForTimeout(900);
  const after20 = await page.evaluate(() => ({ nudgeMs: tracks[0].nudgeMs, label: document.querySelector(".track-subtitle").textContent }));
  check("deux pas de 10 ms = calage +20 ms", after20.nudgeMs === 20 && /calage \+20 ms/.test(after20.label), after20.label);

  await page.click(".nudge button:nth-child(3)");
  await page.waitForTimeout(900);
  const afterReset = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res, rej) => { const r = db.transaction("tracks").objectStore("tracks").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return { duration: all[0].duration, nudgeMs: all[0].nudgeMs, label: document.querySelector(".track-subtitle").textContent };
  });
  check("remise à zéro du calage", afterReset.nudgeMs === 0 && Math.abs(afterReset.duration - wav.duration) < 0.002 && !/calage/.test(afterReset.label),
    `nudge=${afterReset.nudgeMs} · ${afterReset.duration.toFixed(3)} s · ${afterReset.label}`);

  // 8. sauvegarde du projet
  const dl4 = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#saveProjectBtn"),
  ]);
  const jsonPath = path.join(OUT, "projet.json");
  await dl4[0].saveAs(jsonPath);
  const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  check("sauvegarde projet JSON", saved.app === "voicelayer" && saved.tracks.length === 1 && saved.tracks[0].wav.length > 100,
    `${saved.tracks.length} piste(s), ${(fs.statSync(jsonPath).size / 1024).toFixed(0)} Ko`);

  // 8 bis. formes d'onde : chaque piste affiche son amplitude
  await page.waitForTimeout(700);
  const waveInfo = await page.evaluate(() => {
    const canvas = document.querySelector(".wave-canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let strong = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 150) strong++;
    return {
      canvases: document.querySelectorAll(".wave-canvas").length,
      strong,
      size: `${canvas.width}x${canvas.height}`,
      ticks: [...document.querySelectorAll(".wave-ruler span")].map((s) => s.textContent),
      // la règle doit être exactement au-dessus du canevas, sinon les repères
      // de temps ne correspondent pas aux formes d'onde
      alignGap: (() => {
        const r = document.querySelector(".wave-ruler").getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        return Math.round(Math.abs(r.left - c.left) + Math.abs(r.width - c.width));
      })(),
    };
  });
  check("forme d'onde dessinée sur la piste", waveInfo.canvases === 1 && waveInfo.strong > 300, `${waveInfo.size}, ${waveInfo.strong} px de signal`);
  check("règle de temps affichée", waveInfo.ticks.length >= 2, waveInfo.ticks.join(" · "));
  check("règle alignée sur les formes d'onde", waveInfo.alignGap <= 2, `écart ${waveInfo.alignGap} px`);

  // la carte a été repassée en padding 0 (la forme d'onde doit toucher les bords)
  const layout = await page.evaluate(() => {
    const card = document.querySelector(".track-card");
    const head = card.querySelector(".track-head");
    const row = card.querySelector(".wave-row");
    return {
      cardPad: getComputedStyle(card).paddingLeft,
      headPad: getComputedStyle(head).paddingLeft,
      rowInset: Math.round(row.getBoundingClientRect().left - card.getBoundingClientRect().left),
    };
  });
  check("mise en page des cartes intacte", layout.cardPad === "0px" && layout.headPad === "14px" && layout.rowInset <= 1, JSON.stringify(layout));

  // 8 ter. échelle de temps commune : une piste deux fois plus longue doit
  // occuper deux fois plus de largeur. C'est ce qui rend la synchronisation
  // possible — sinon chaque forme d'onde est étirée à sa propre durée.
  await page.evaluate(async () => {
    const sr = 44100;
    const long = Math.round(sr * 6);
    const samples = new Int16Array(long);
    for (let i = 0; i < long; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 12000);
    await storeItem("tracks", {
      id: `synthetic-${Date.now()}`,
      name: "Piste longue (test)",
      createdAt: Date.now(),
      blob: wavFromInt16(samples, sr, 1),
      sampleRate: sr,
      duration: samples.length / sr,
      volume: 1,
      muted: false,
      nudgeMs: 0,
      peak: 0.37,
    });
  });

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll(".wave-canvas");
    if (canvases.length < 2) return false;
    return [...canvases].every((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 150) return true;
      return false;
    });
  }, null, { timeout: 15000 });

  const extents = await page.evaluate(() => [...document.querySelectorAll(".wave-canvas")].map((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let last = 0;
    for (let x = 0; x < canvas.width; x++) {
      for (let y = 0; y < canvas.height; y++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 150) { last = x; break; }
      }
    }
    return Math.round((last / canvas.width) * 100);
  }));
  const ratio = extents[1] / Math.max(1, extents[0]);
  check("échelle de temps commune aux pistes", ratio > 1.8 && ratio < 2.6,
    `occupation ${extents.join(" % / ")} % → rapport ${ratio.toFixed(2)} (attendu ≈ 2)`);

  // 8 quater. le curseur de lecture doit avancer sur les formes d'onde
  await page.click("#playBtn");
  await page.waitForTimeout(400);
  const ph1 = await page.evaluate(() => parseFloat(document.querySelector(".wave-playhead").style.left) || 0);
  await page.waitForTimeout(700);
  const ph2 = await page.evaluate(() => ({
    left: parseFloat(document.querySelector(".wave-playhead").style.left) || 0,
    display: document.querySelector(".wave-playhead").style.display,
  }));
  await page.click("#playBtn");
  await page.waitForTimeout(300);
  const phOff = await page.evaluate(() => document.querySelector(".wave-playhead").style.display);
  check("curseur de lecture visible et mobile", ph2.display === "block" && ph2.left > ph1, `${ph1.toFixed(1)} % → ${ph2.left.toFixed(1)} %`);
  check("curseur masqué à l'arrêt", phOff === "none", phOff);

  // 9. le retour casque ne doit JAMAIS être mémorisé : sur téléphone, un retour
  // resté actif au rechargement produirait un larsen dès l'ouverture.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() => ({
    monitoring,
    gain: monitorGain ? monitorGain.gain.value : null,
    pressed: document.getElementById("monitorBtn").getAttribute("aria-pressed"),
    stored: Object.keys(localStorage).filter((k) => /monitor|casque/i.test(k)),
  }));
  check("retour casque toujours coupé après rechargement",
    afterReload.monitoring === false && afterReload.pressed === "false" && (afterReload.gain === null || afterReload.gain === 0) && afterReload.stored.length === 0,
    JSON.stringify(afterReload));

  check("aucune erreur JavaScript", errors.length === 0, errors.slice(0, 3).join(" | ") || "aucune");

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contrôles passés`);
  fs.writeFileSync(path.join(OUT, "resultats.json"), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERREUR DU TEST :", e.message); process.exit(2); });
