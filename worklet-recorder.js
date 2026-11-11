/*
  VoiceLayer — capture PCM dans l'horloge de l'AudioContext.

  Pourquoi ce fichier existe : MediaRecorder produit du WebM/Opus sur une horloge
  opaque, qui ne partage pas celle de la lecture des pistes d'accompagnement.
  C'est la source du décalage au démarrage. Ici la capture se fait dans le même
  AudioContext que la lecture : l'échantillon 0 a un instant connu (firstTime),
  donc le recouvrement avec la piste d'accompagnement est calculé en échantillons,
  sans estimation ni marge arbitraire.

  Sortie : des blocs Int16 (PCM 16 bits) transférés au thread principal à l'arrêt.
*/

const CHUNK_SECONDS = 1;

class PcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.state = "idle";
    this.firstTime = -1;
    this.chunkSize = Math.max(1024, Math.round(sampleRate * CHUNK_SECONDS));
    this.buffer = new Int16Array(this.chunkSize);
    this.pos = 0;
    this.chunks = [];

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.cmd === "start") {
        this.chunks = [];
        this.pos = 0;
        this.firstTime = -1;
        this.state = "recording";
      } else if (data.cmd === "stop") {
        this.flush();
        const chunks = this.chunks;
        this.chunks = [];
        this.state = "idle";
        this.port.postMessage({ type: "done", firstTime: this.firstTime, chunks }, chunks);
      }
    };
  }

  flush() {
    if (this.pos > 0) {
      // slice() copie : le buffer est réutilisé pour le bloc suivant.
      this.chunks.push(this.buffer.slice(0, this.pos).buffer);
      this.pos = 0;
    }
  }

  process(inputs) {
    if (this.state !== "recording") return true;

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || !channel.length) return true;

    // currentTime est l'horloge de l'AudioContext, la même que celle de la
    // lecture des accompagnements : c'est ce qui rend l'alignement exact.
    if (this.firstTime < 0) this.firstTime = currentTime;

    const buf = this.buffer;
    const size = this.chunkSize;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i] < -1 ? -1 : channel[i] > 1 ? 1 : channel[i];
      buf[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.pos >= size) this.flush();
    }

    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
