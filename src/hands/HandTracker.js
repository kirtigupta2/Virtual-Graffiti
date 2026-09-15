import { Hands } from "@mediapipe/hands";

const PINCH_ON_THRESHOLD = 0.35;
const PINCH_OFF_THRESHOLD = 0.45;

/**
 * Runs MediaPipe Hands (WASM) on the front-facing camera so the user's
 * free hand can pinch a "spray trigger" while the rear camera stays
 * dedicated to the WebXR compositor for AR passthrough/tracking - most
 * phones can't serve the same physical camera to two consumers at once.
 */
export class HandTracker {
  constructor({ onPinchChange }) {
    this.onPinchChange = onPinchChange;
    this.video = null;
    this.stream = null;
    this.hands = null;
    this.running = false;
    this.isPinching = false;
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
      return;
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
    this._setPinching(false);
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
