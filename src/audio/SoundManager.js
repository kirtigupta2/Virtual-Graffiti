const RATTLE_URL = "/audio/can_rattle.mp3";
const HISS_URL = "/audio/spray_hiss.mp3";
const FADE_SECONDS = 0.05;

export class SoundManager {
  constructor() {
    this.context = null;
    this.rattleBuffer = null;
    this.hissBuffer = null;
    this.hissSource = null;
    this.hissGain = null;
  }

  /** Must be called from inside a user-gesture handler (e.g. the Enter AR tap). */
  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.context = new Ctx();
    if (this.context.state === "suspended") await this.context.resume();

    const [rattleData, hissData] = await Promise.all([
      fetch(RATTLE_URL).then((r) => r.arrayBuffer()),
      fetch(HISS_URL).then((r) => r.arrayBuffer()),
    ]);

    [this.rattleBuffer, this.hissBuffer] = await Promise.all([
      this.context.decodeAudioData(rattleData),
      this.context.decodeAudioData(hissData),
    ]);
  }

  playRattle() {
    if (!this.context || !this.rattleBuffer) return;
    const source = this.context.createBufferSource();
    source.buffer = this.rattleBuffer;
    source.connect(this.context.destination);
    source.start();
  }

  startHiss() {
    if (!this.context || !this.hissBuffer || this.hissSource) return;

    const source = this.context.createBufferSource();
    source.buffer = this.hissBuffer;
    source.loop = true;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, this.context.currentTime);
    gain.gain.linearRampToValueAtTime(
      1,
      this.context.currentTime + FADE_SECONDS,
    );

    source.connect(gain).connect(this.context.destination);
    source.start();

    this.hissSource = source;
    this.hissGain = gain;
  }

  stopHiss() {
    if (!this.context || !this.hissSource) return;

    const now = this.context.currentTime;
    this.hissGain.gain.cancelScheduledValues(now);
    this.hissGain.gain.setValueAtTime(this.hissGain.gain.value, now);
    this.hissGain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);

    const source = this.hissSource;
    source.stop(now + FADE_SECONDS + 0.01);

    this.hissSource = null;
    this.hissGain = null;
  }
}
