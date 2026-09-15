import * as THREE from "three";
import { Hands } from "@mediapipe/hands";

const PINCH_ON_THRESHOLD = 0.35;
const PINCH_OFF_THRESHOLD = 0.45;
// See HandTracker.js for why these confirm-frame counts exist: single-
// frame landmark jitter (more likely here given the downsampled,
// throttled feed) would otherwise flip isPinching spuriously.
const PINCH_ON_CONFIRM_FRAMES = 3;
const PINCH_OFF_CONFIRM_FRAMES = 2;
const HAND_LOST_CONFIRM_TICKS = 4; // processed ticks, not raw XR frames
const PROCESS_EVERY_N_FRAMES = 3; // ~20fps at a 60Hz XR frame rate
const DOWNSAMPLE_WIDTH = 256;
const DOWNSAMPLE_HEIGHT = 192;

/**
 * Tracks the user's hand directly in the WebXR session's rear-camera
 * passthrough feed via the "camera-access" WebXR module
 * (XRWebGLBinding.getCameraImage), so the pinch position is spatially
 * meaningful in the same camera space as the AR world - unlike a
 * front-camera feed, which faces the user and shares no geometric
 * relationship with what the rear camera sees. This is an experimental,
 * permission-gated browser feature, so every entry point here is
 * defensive: any failure marks the tracker unavailable rather than
 * throwing, so the caller can fall back to front-camera tracking.
 */
export class RawCameraHandTracker {
  constructor({ renderer, onPinchChange, onHandDetected }) {
    this.renderer = renderer;
    this.onPinchChange = onPinchChange;
    this.onHandDetected = onHandDetected;
    this.handPresent = false;

    this.gl = null;
    this.binding = null;
    this.readFb = null;
    this.smallFb = null;
    this.smallTexture = null;
    this.pixelBuffer = new Uint8Array(DOWNSAMPLE_WIDTH * DOWNSAMPLE_HEIGHT * 4);
    this.flippedBuffer = new Uint8ClampedArray(
      DOWNSAMPLE_WIDTH * DOWNSAMPLE_HEIGHT * 4,
    );

    this.canvas = document.createElement("canvas");
    this.canvas.width = DOWNSAMPLE_WIDTH;
    this.canvas.height = DOWNSAMPLE_HEIGHT;
    this.ctx2d = this.canvas.getContext("2d");

    this.hands = null;
    this.busy = false;
    this.frameCounter = 0;

    this.available = false;
    this.isPinching = false;
    this.lastPinchMetric = null;
    /** Message from the last init/processFrame failure, for on-screen debugging. */
    this.lastError = null;

    /** World-space ray through the tracked palm (landmark 9), or null. */
    this.palmRay = null;

    this._missingTickCount = 0;
    this._pinchOnStreak = 0;
    this._pinchOffStreak = 0;
  }

  /** Call once after the XR session has started. Never throws. */
  init(session) {
    try {
      this.gl = this.renderer.getContext();
      this.binding = new XRWebGLBinding(session, this.gl);

      const gl = this.gl;
      this.readFb = gl.createFramebuffer();

      this.smallTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.smallTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        DOWNSAMPLE_WIDTH,
        DOWNSAMPLE_HEIGHT,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.smallFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.smallFb);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.smallTexture,
        0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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

      return true;
    } catch (err) {
      console.warn("Raw camera access unavailable", err);
      this.available = false;
      this.lastError = `${err.name}: ${err.message}`;
      return false;
    }
  }

  /** Call once per XR frame with the frame and its matching XRView. */
  processFrame(frame, view) {
    if (!this.binding || !view.camera) {
      this.available = false;
      if (!this.lastError) {
        this.lastError = !this.binding
          ? "XRWebGLBinding failed to construct"
          : "view.camera absent (camera-access not granted/supported)";
      }
      return;
    }

    this._updateRay(view);

    this.frameCounter++;
    if (this.busy || this.frameCounter % PROCESS_EVERY_N_FRAMES !== 0) return;

    try {
      const glTexture = this.binding.getCameraImage(view.camera);
      if (!glTexture) return;

      const gl = this.gl;
      const { width: camWidth, height: camHeight } = view.camera;

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFb);
      gl.framebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        glTexture,
        0,
      );
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.smallFb);
      gl.blitFramebuffer(
        0,
        0,
        camWidth,
        camHeight,
        0,
        0,
        DOWNSAMPLE_WIDTH,
        DOWNSAMPLE_HEIGHT,
        gl.COLOR_BUFFER_BIT,
        gl.LINEAR,
      );

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.smallFb);
      gl.readPixels(
        0,
        0,
        DOWNSAMPLE_WIDTH,
        DOWNSAMPLE_HEIGHT,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.pixelBuffer,
      );

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._flipRowsInto(this.flippedBuffer);
      const imageData = new ImageData(
        this.flippedBuffer,
        DOWNSAMPLE_WIDTH,
        DOWNSAMPLE_HEIGHT,
      );
      this.ctx2d.putImageData(imageData, 0, 0);

      this.available = true;
      this.busy = true;
      this.hands
        .send({ image: this.canvas })
        .catch((err) => console.warn("MediaPipe send failed", err))
        .finally(() => {
          this.busy = false;
        });
    } catch (err) {
      console.warn("Raw camera frame processing failed", err);
      this.available = false;
      this.lastError = `${err.name}: ${err.message}`;
    }
  }

  _flipRowsInto(dest) {
    const rowBytes = DOWNSAMPLE_WIDTH * 4;
    for (let y = 0; y < DOWNSAMPLE_HEIGHT; y++) {
      const srcStart = (DOWNSAMPLE_HEIGHT - 1 - y) * rowBytes;
      const destStart = y * rowBytes;
      dest.set(
        this.pixelBuffer.subarray(srcStart, srcStart + rowBytes),
        destStart,
      );
    }
  }

  _updateRay(view) {
    // Palm ray defaults to straight ahead from the viewer until the
    // first MediaPipe result arrives with a real landmark position.
    if (!this._lastPalmUV) return;

    const projInv = new THREE.Matrix4()
      .fromArray(view.projectionMatrix)
      .invert();
    const viewWorld = new THREE.Matrix4().fromArray(view.transform.matrix);

    const ndcX = this._lastPalmUV.x * 2 - 1;
    const ndcY = -(this._lastPalmUV.y * 2 - 1);

    const point = new THREE.Vector3(ndcX, ndcY, 0.5);
    point.applyMatrix4(projInv);
    point.applyMatrix4(viewWorld);

    const origin = new THREE.Vector3().setFromMatrixPosition(viewWorld);
    const direction = point.sub(origin).normalize();

    this.palmRay = { origin, direction };
  }

  _onResults(results) {
    const landmarks = results.multiHandLandmarks?.[0];
    if (!landmarks) {
      this._missingTickCount++;
      if (this._missingTickCount >= HAND_LOST_CONFIRM_TICKS) {
        this._setPinching(false);
        this._lastPalmUV = null;
        this.palmRay = null;
        this.handPresent = false;
      }
      return;
    }
    this._missingTickCount = 0;

    if (!this.handPresent) {
      this.handPresent = true;
      if (this.onHandDetected) this.onHandDetected();
    }

    const palm = landmarks[9]; // MIDDLE_FINGER_MCP, used as the palm-center anchor
    this._lastPalmUV = { x: palm.x, y: palm.y };

    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];

    const pinchDist = distance(thumbTip, indexTip);
    const handScale = distance(wrist, middleMcp) || 1;
    const normalized = pinchDist / handScale;
    this.lastPinchMetric = normalized;

    if (!this.isPinching) {
      this._pinchOnStreak = normalized < PINCH_ON_THRESHOLD ? this._pinchOnStreak + 1 : 0;
      if (this._pinchOnStreak >= PINCH_ON_CONFIRM_FRAMES) this._setPinching(true);
    } else {
      this._pinchOffStreak = normalized > PINCH_OFF_THRESHOLD ? this._pinchOffStreak + 1 : 0;
      if (this._pinchOffStreak >= PINCH_OFF_CONFIRM_FRAMES) this._setPinching(false);
    }
  }

  _setPinching(value) {
    this._pinchOnStreak = 0;
    this._pinchOffStreak = 0;
    if (this.isPinching === value) return;
    this.isPinching = value;
    if (this.onPinchChange) this.onPinchChange(value);
  }

  dispose() {
    const gl = this.gl;
    if (gl) {
      if (this.readFb) gl.deleteFramebuffer(this.readFb);
      if (this.smallFb) gl.deleteFramebuffer(this.smallFb);
      if (this.smallTexture) gl.deleteTexture(this.smallTexture);
    }
    this.hands?.close();
    this.hands = null;
    this.binding = null;
    this.available = false;
    this.palmRay = null;
    this._lastPalmUV = null;
    this.handPresent = false;
    this.lastPinchMetric = null;
    this._missingTickCount = 0;
    this._setPinching(false);
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
