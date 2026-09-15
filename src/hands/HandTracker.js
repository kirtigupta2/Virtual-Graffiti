import { Hands } from "@mediapipe/hands";

const PINCH_ON_THRESHOLD = 0.35;
const PINCH_OFF_THRESHOLD = 0.45;

// Wrist speed in normalized-frame-widths/second that counts as a
// "shake" (rattling the can), and the minimum gap between triggers so
// one shaking motion doesn't fire a burst of overlapping rattles.
const SHAKE_SPEED_THRESHOLD = 2.5;
const SHAKE_DEBOUNCE_MS = 500;

/**
 * Runs MediaPipe Hands (WASM) on the front-facing camera so the user's
 * free hand can pinch a "spray trigger" while the rear camera stays
 * dedicated to the WebXR compositor for AR passthrough/tracking - most
 * phones can't serve the same physical camera to two consumers at once.
 */
export class HandTracker {
  constructor({ onPinchChange, onHandDetected, onShake }) {
    this.onPinchChange = onPinchChange;
    this.onHandDetected = onHandDetected;
    this.onShake = onShake;

    this.video = null;
    this.stream = null;
    this.hands = null;
    this.running = false;
    this.isPinching = false;
    this.handPresent = false;

    this._prevWrist = null;
    this._prevTime = null;
    this._lastShakeTime = 0;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start() {
    if (!HandTracker.isSupported()) {
      throw new Error("Camera access is not available in this browser");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 320, height: 240 },
      audio: false,
    });

    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    this.hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    this.hands.onResults((results) => this._onResults(results));

    this.running = true;
    this._loop();
  }

  async _loop() {
    while (this.running) {
      if (this.video.readyState >= 2) {
        await this.hands.send({ image: this.video });
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  _onResults(results) {
    const landmarks = results.multiHandLandmarks?.[0];
    if (!landmarks) {
      this._setPinching(false);
      this.handPresent = false;
      this._prevWrist = null;
      this._prevTime = null;
      return;
    }

    if (!this.handPresent) {
      this.handPresent = true;
      if (this.onHandDetected) this.onHandDetected();
    }

    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];

    const pinchDist = distance(thumbTip, indexTip);
    const handScale = distance(wrist, middleMcp) || 1;
    const normalized = pinchDist / handScale;

    if (!this.isPinching && normalized < PINCH_ON_THRESHOLD) {
      this._setPinching(true);
    } else if (this.isPinching && normalized > PINCH_OFF_THRESHOLD) {
      this._setPinching(false);
    }

    this._trackShake(wrist);
  }

  _trackShake(wrist) {
    const now = performance.now();

    if (this._prevWrist && this._prevTime) {
      const dt = (now - this._prevTime) / 1000;
      if (dt > 0) {
        const dx = wrist.x - this._prevWrist.x;
        const dy = wrist.y - this._prevWrist.y;
        const speed = Math.sqrt(dx * dx + dy * dy) / dt;

        if (
          speed > SHAKE_SPEED_THRESHOLD &&
          now - this._lastShakeTime > SHAKE_DEBOUNCE_MS
        ) {
          this._lastShakeTime = now;
          if (this.onShake) this.onShake();
        }
      }
    }

    this._prevWrist = { x: wrist.x, y: wrist.y };
    this._prevTime = now;
  }

  _setPinching(value) {
    if (this.isPinching === value) return;
    this.isPinching = value;
    if (this.onPinchChange) this.onPinchChange(value);
  }

  stop() {
    this.running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.hands?.close();
    this.hands = null;
    this.video = null;
    this.stream = null;
    this.handPresent = false;
    this._prevWrist = null;
    this._prevTime = null;
    this._setPinching(false);
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
