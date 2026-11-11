/* Fournit un faux microphone continu (sinus 440 Hz) au lieu du bip périodique
   du périphérique de test de Chrome. Sans ça, une mesure instantanée tombe
   régulièrement dans un creux et fait croire à un micro muet. */

const fs = require("fs");
const path = require("path");

function ensureTone(seconds = 4, freq = 440, rate = 48000, amp = 0.35) {
  const dir = path.join(__dirname, "out");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "micro-simule.wav");
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;

  const frames = Math.round(seconds * rate);
  const channels = 2;
  const buf = Buffer.alloc(44 + frames * channels * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * channels * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * channels * 2, 40);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(32767 * amp * Math.sin((2 * Math.PI * freq * i) / rate));
    for (let c = 0; c < channels; c++) { buf.writeInt16LE(v, o); o += 2; }
  }
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { ensureTone };
