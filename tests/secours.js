/* Vérifie les deux garde-fous ajoutés après la prise silencieuse de 11 s :
   1. le décompte annule la prise si le micro n'envoie rien ;
   2. si la capture PCM revient vide alors que le micro émettait, la prise est
      récupérée par le MediaRecorder parallèle (chemin de secours).

   Le cas 2 est provoqué en vidant les blocs renvoyés par l'AudioWorklet, ce qui
   reproduit exactement ce que l'utilisateur a vécu, sans toucher au matériel. */

const { chromium } = require("playwright-core");
const path = require("path");
const { ensureTone } = require("./tone");

const CHROME = process.env.CHROME || undefined;
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8099/index.html";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function launch(browser, silent) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return page;
}

(async () => {
  const toneFile = ensureTone();

  // fichier silencieux pour simuler un micro muet
  const fs = require("fs");
  const silentFile = path.join(__dirname, "out", "micro-muet.wav");
  if (!fs.existsSync(silentFile)) {
    fs.mkdirSync(path.dirname(silentFile), { recursive: true });
    const frames = 48000 * 3, ch = 2;
    const buf = Buffer.alloc(44 + frames * ch * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * ch * 2, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(48000 * ch * 2, 28);
    buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
    buf.write("data", 36); buf.writeUInt32LE(frames * ch * 2, 40);
    fs.writeFileSync(silentFile, buf);
  }

  // ---------- Cas 1 : micro muet -> la prise est annulée avant d'enregistrer
  {
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${silentFile}`,
        "--autoplay-policy=no-user-gesture-required",
        "--no-sandbox",
      ],
    });

    const page = await browser.newPage();
    await page.goto(APP_URL);
    await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });

    // Une piste d'accompagnement existante : c'est elle que l'utilisateur doit
    // entendre pendant la prise, même si son micro est muet.
    await page.evaluate(async () => {
      const sr = 44100, frames = sr * 2;
      const buf = new ArrayBuffer(44 + frames * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + frames * 2, true); w(8, "WAVE");
      w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / sr)), true);
      const blob = new Blob([buf], { type: "audio/wav" });

      const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise((res, rej) => {
        const tx = db.transaction("tracks", "readwrite");
        tx.objectStore("tracks").put({ id: "accompagnement", name: "Accompagnement", blob, sampleRate: sr, duration: 2, volume: 1, muted: false, createdAt: Date.now() });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });
    await page.waitForSelector(".track-card", { timeout: 15000 });

    await page.click("#recordBtn");
    await page.waitForFunction(() => document.getElementById("micState").textContent === "Enregistrement", null, { timeout: 15000 });
    await page.waitForTimeout(2600);   // le témoin "aucun son" se déclenche à 2 s

    const during = await page.evaluate(() => ({
      status: document.getElementById("statusMessage").textContent,
      playing: playSources.length,
      isPlaying: playSources.some((s) => s.buffer && s.buffer.duration > 0),
      locked: document.getElementById("recordBtn").disabled,
    }));

    check("micro muet : la prise DÉMARRE quand même", during.locked === true, `état verrouillé=${during.locked}`);
    check("micro muet : l'accompagnement est bien lancé", during.playing > 0 && during.isPlaying, `${during.playing} source(s) audio`);
    check("micro muet : un avertissement s'affiche sans bloquer", /Aucun son depuis 2 secondes/.test(during.status), during.status.slice(0, 90));

    await page.click("#stopBtn");
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      cards: document.querySelectorAll(".track-card").length,
      subtitle: document.querySelectorAll(".track-subtitle")[1] ? document.querySelectorAll(".track-subtitle")[1].textContent : "",
      recordDisabled: document.getElementById("recordBtn").disabled,
    }));

    check("la prise silencieuse est conservée et signalée", after.cards === 2 && /SILENCIEUSE/.test(after.subtitle), `${after.cards} piste(s) · ${after.subtitle}`);
    check("boutons rendus après la prise", after.recordDisabled === false, `enregistrer désactivé=${after.recordDisabled}`);
    await browser.close();
  }

  // ---------- Cas 2 : capture PCM vide -> récupération par le chemin de secours
  {
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${toneFile}`,
        "--autoplay-policy=no-user-gesture-required",
        "--no-sandbox",
      ],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
    await page.goto(APP_URL);
    await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });

    // On vide les blocs PCM renvoyés par l'AudioWorklet : le micro émet, la jauge
    // monte, mais l'enregistreur PCM ne reçoit rien — le cas vécu.
    await page.evaluate(() => {
      const original = recorderNode.port.onmessage;
      recorderNode.port.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === "done") { original({ data: { ...data, chunks: [] } }); return; }
        original(event);
      };
    });

    await page.click("#recordBtn");
    await page.waitForFunction(() => document.getElementById("micState").textContent === "Enregistrement", null, { timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.click("#stopBtn");
    await page.waitForSelector(".track-card", { timeout: 20000 });
    await page.waitForTimeout(800);

    const after = await page.evaluate(() => ({
      status: document.getElementById("statusMessage").textContent,
      peak: tracks[0] && tracks[0].peak,
      duration: tracks[0] && tracks[0].duration,
      subtitle: document.querySelector(".track-subtitle").textContent,
    }));

    check("capture PCM vide : la prise est récupérée", /chemin de secours/i.test(after.status), after.status.slice(0, 110));
    check("la prise récupérée contient du son", after.peak > 0.05, `crête ${after.peak}`);
    check("durée plausible", after.duration > 1.2 && after.duration < 3.5, `${after.duration && after.duration.toFixed(2)} s`);
    check("aucune erreur JavaScript", errors.length === 0, errors.join(" | ") || "aucune");
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contrôles passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERREUR DU TEST :", e.message); process.exit(2); });
