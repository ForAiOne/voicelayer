/* Vérifie la migration des pistes de la V0.2 (Blob WebM/Opus) vers le moteur
   WAV de la V1 : rien ne doit être perdu quand Tony ouvre la nouvelle version
   avec ses anciennes prises dans IndexedDB. */

const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { ensureTone } = require("./tone");

const CHROME = "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const OUT = "/root/projets/voicelayer/test/out";

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
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${ensureTone()}`, "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));

  await page.goto("http://127.0.0.1:8099/index.html");
  await page.waitForFunction(() => /Hz/.test(document.getElementById("enginePill").textContent), null, { timeout: 20000 });

  // 1. Fabriquer une piste « ancienne version » : un vrai Blob WebM/Opus dans IndexedDB.
  const legacy = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.start(100);
      setTimeout(() => recorder.stop(), 4000);
    });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("tracks", "readwrite");
      tx.objectStore("tracks").put({
        id: "legacy-v02-1",
        name: "Piste de la V0.2",
        blob,
        mimeType: blob.type,
        duration: 4,
        volume: 1,
        muted: false,
        createdAt: Date.now() - 10000,
      });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return { type: blob.type, size: blob.size };
  });
  check("piste ancienne version déposée en base", legacy.size > 1000, `${legacy.type} · ${(legacy.size / 1024).toFixed(0)} Ko`);

  // 2. Recharger : la migration doit convertir sans rien supprimer.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /convertie/.test(document.getElementById("statusMessage").textContent), null, { timeout: 25000 });
  const status = await page.textContent("#statusMessage");
  check("l'application annonce la conversion", /convertie/.test(status), status);

  const after = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("voicelayer-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res, rej) => { const r = db.transaction("tracks").objectStore("tracks").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const t = all[0];
    const bytes = new Uint8Array(await t.blob.arrayBuffer());
    return { count: all.length, type: t.blob.type, duration: t.duration, size: bytes.length, name: t.name, head: String.fromCharCode(...bytes.subarray(0, 4)) };
  });

  check("une seule piste, toujours présente", after.count === 1, `${after.count} piste(s)`);
  check("la piste est convertie en WAV", after.type === "audio/wav" && after.head === "RIFF", `${after.type} / ${after.head}`);
  check("durée conservée", Math.abs(after.duration - 4) < 0.4, `${after.duration.toFixed(2)} s`);

  // 3. L'ancienne piste doit être lisible par le nouveau moteur : export non silencieux.
  const dl = await Promise.all([page.waitForEvent("download", { timeout: 25000 }), page.click("#exportBtn")]);
  const mixPath = path.join(OUT, "mix-migration.wav");
  await dl[0].saveAs(mixPath);
  const buf = fs.readFileSync(mixPath);
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i) / 32768);
    if (v > peak) peak = v;
  }
  check("le mix exporté contient le son de l'ancienne piste", peak > 0.01, `crête ${peak.toFixed(3)}`);
  check("aucune erreur JavaScript", errors.length === 0, errors.join(" | ") || "aucune");

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contrôles passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERREUR DU TEST :", e.message); process.exit(2); });
