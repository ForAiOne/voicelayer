/* Vérifie que l'application distingue une prise réelle d'une prise silencieuse.
   C'est le témoin qui tranche entre « le micro n'a rien capté » et « le son ne sort
   pas » quand l'utilisateur dit « je n'entends rien ». */

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

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${ensureTone()}`, "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));

  await page.goto(APP_URL);
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });

  // 1. Déposer une piste WAV entièrement silencieuse (1 s de zéros).
  const injected = await page.evaluate(async () => {
    const sr = 44100, frames = sr;
    const buf = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); w(8, "WAVE");
    w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    w(36, "data"); view.setUint32(40, frames * 2, true);
    const blob = new Blob([buf], { type: "audio/wav" });

    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("tracks", "readwrite");
      tx.objectStore("tracks").put({
        id: "prise-morte", name: "Prise sans signal", blob,
        sampleRate: sr, duration: 1, volume: 1, muted: false, createdAt: Date.now(),
      });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return true;
  });
  check("piste silencieuse déposée sans niveau mesuré", injected, "aucun champ peak");

  // 2. Au chargement, le niveau est calculé et la piste est signalée.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });
  await page.waitForSelector(".track-card", { timeout: 15000 });
  await page.waitForTimeout(600);

  const state = await page.evaluate(() => {
    const card = document.querySelector(".track-card");
    return {
      subtitle: card.querySelector(".track-subtitle").textContent,
      classes: card.className,
      peak: window.tracks && tracks[0] ? tracks[0].peak : null,
    };
  });

  check("le niveau nul est mesuré", state.peak === 0, `peak=${state.peak}`);
  check("la piste est marquée SILENCIEUSE", /SILENCIEUSE/.test(state.subtitle), state.subtitle);
  check("la carte est signalée visuellement", /is-silent/.test(state.classes), state.classes);
  check("aucune erreur JavaScript", errors.length === 0, errors.join(" | ") || "aucune");

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contrôles passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERREUR DU TEST :", e.message); process.exit(2); });
