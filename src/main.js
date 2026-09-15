import * as THREE from "three";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ArSession } from "./xr/ArSession.js";
import { HandTracker } from "./hands/HandTracker.js";
import { RawCameraHandTracker } from "./hands/RawCameraHandTracker.js";
import { SpraySystem, SPRAY_COLORS } from "./graffiti/SpraySystem.js";
import { SoundManager } from "./audio/SoundManager.js";
import { intersectRayPlane } from "./utils/rayPlane.js";

// How many XR frames to wait for the WebXR "camera-access" module
// (XRWebGLBinding.getCameraImage) to prove itself available before
// giving up and falling back to front-camera hand-tracking. It's an
// experimental, permission-gated feature, so this can't be known ahead
// of a live session.
const RAW_CAMERA_GRACE_FRAMES = 60;
const HELD_CAN_HUD_POSITION = new THREE.Vector3(0.13, -0.14, -0.3);
const PALM_CAN_DISTANCE = 0.35;

const canvas = document.getElementById("app-canvas");
const startScreen = document.getElementById("start-screen");
const arButton = document.getElementById("ar-button");
const unsupportedNote = document.getElementById("unsupported-note");
const xrOverlay = document.getElementById("xr-overlay");
const xrStatus = document.getElementById("xr-status");
const debugEl = document.getElementById("debug-info");
const xrExitButton = document.getElementById("xr-exit");
const paletteEl = document.getElementById("palette");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 20);
// Children of the camera (the held-can HUD prop) only render if the
// camera itself is reachable from the scene graph the renderer
// traverses - three.js's WebXR manager keeps this camera's matrixWorld
// synced to the live XR pose each frame, so this is safe in-session too.
scene.add(camera);

// Mobile Chrome can report a 0 or stale window.innerHeight on the very
// first synchronous tick (before the dynamic toolbar/layout settles),
// which would otherwise poison the projection matrix with a garbage
// aspect ratio, so fall back to documentElement's size and re-apply on
// the next frame in case layout was still settling at first call.
function currentViewportSize() {
  const w = window.innerWidth || document.documentElement.clientWidth || 1;
  const h = window.innerHeight || document.documentElement.clientHeight || 1;
  return { w, h };
}

function applyViewportSize() {
  const { w, h } = currentViewportSize();
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

applyViewportSize();
requestAnimationFrame(applyViewportSize);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(1, 2, 1);
scene.add(keyLight);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.065, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
);
reticle.visible = false;
scene.add(reticle);

let previewGroup = null;
let heldCanGroup = null;

for (let i = 0; i < SPRAY_COLORS.length; i++) {
  const btn = document.createElement("button");
  btn.className = "swatch";
  if (i === 0) btn.classList.add("active");
  btn.style.background = `#${SPRAY_COLORS[i].toString(16).padStart(6, "0")}`;
  btn.addEventListener("click", () => {
    spraySystem.setColorIndex(i);
    for (const el of paletteEl.children) el.classList.remove("active");
    btn.classList.add("active");
  });
  paletteEl.appendChild(btn);
}

window.addEventListener("resize", applyViewportSize);
window.addEventListener("orientationchange", applyViewportSize);
window.visualViewport?.addEventListener("resize", applyViewportSize);

const spraySystem = new SpraySystem({ scene });
const soundManager = new SoundManager();

let isPinching = false;
let isTouching = false;
let wasSpraying = false;
let hasPlayedFallbackRattle = false;

// 'pending' (deciding), 'raw-camera' (rear-camera hand-tracking via
// WebXR camera-access, palm-anchored), 'front-camera' (fallback:
// front-camera gesture as a trigger only, position via screen-center
// reticle), or 'touch-only' (no camera at all, tap-and-hold).
let handTrackingMode = "pending";
let rawCameraGraceFrames = 0;
let rawCameraTracker = null;
// Whether the front-facing getUserMedia stream + MediaPipe pipeline is
// already running, acquired *before* the AR session starts (see the
// ar-button handler): requesting it mid-session was unreliable, since
// Chrome appears to restrict additional camera permission prompts
// while an immersive-ar session is already presenting fullscreen.
let frontCameraReady = false;
let frontCameraError = null;

function isSpraying() {
  return isPinching || isTouching;
}

function isHandTrackingActive() {
  return handTrackingMode === "raw-camera" || handTrackingMode === "front-camera";
}

const handTracker = new HandTracker({
  onPinchChange: (pinching) => {
    isPinching = pinching;
  },
  onHandDetected: () => {
    soundManager.playRattle();
  },
  onShake: () => {
    soundManager.playRattle();
  },
});

const arSession = new ArSession({
  renderer,
  overlayRoot: xrOverlay,
  onSessionStart: (session) => {
    startScreen.style.display = "none";
    xrOverlay.classList.add("active");
    xrStatus.textContent = "Move phone to find a surface";
    if (heldCanGroup) heldCanGroup.visible = true;

    handTrackingMode = "pending";
    rawCameraGraceFrames = 0;
    rawCameraTracker = new RawCameraHandTracker({
      renderer,
      onPinchChange: (pinching) => {
        isPinching = pinching;
      },
      onHandDetected: () => {
        soundManager.playRattle();
      },
    });
    rawCameraTracker.init(session);
  },
  onSessionEnd: () => {
    handTracker.stop();
    frontCameraReady = false;
    rawCameraTracker?.dispose();
    rawCameraTracker = null;
    handTrackingMode = "pending";
    soundManager.stopHiss();
    isPinching = false;
    isTouching = false;
    wasSpraying = false;
    hasPlayedFallbackRattle = false;
    reticle.visible = false;
    if (heldCanGroup) {
      heldCanGroup.visible = false;
      heldCanGroup.position.copy(HELD_CAN_HUD_POSITION);
    }

    startScreen.style.display = "flex";
    xrOverlay.classList.remove("active");
    arButton.disabled = false;
    arButton.textContent = "Enter AR";

    if (previewGroup) scene.add(previewGroup);
  },
  onSelectStart: () => {
    isTouching = true;
  },
  onSelectEnd: () => {
    isTouching = false;
  },
});

xrExitButton.addEventListener("click", () => arSession.end());

arButton.addEventListener("click", async () => {
  arButton.disabled = true;
  arButton.textContent = "Starting…";
  unsupportedNote.hidden = true;

  try {
    await soundManager.init();
  } catch (err) {
    console.warn("Audio init failed, continuing without sound", err);
  }

  // Acquire the front-camera fallback *before* entering the AR session:
  // requesting getUserMedia mid-session was unreliable (see the
  // frontCameraReady comment above). Whether it actually gets used
  // depends on whether WebXR camera-access proves out once the session
  // starts (see onSessionStart / the animate loop's 'pending' branch);
  // it just needs to already be running by then, not requested then.
  try {
    await handTracker.start();
    frontCameraReady = true;
    frontCameraError = null;
  } catch (err) {
    console.warn("Front-camera hand-tracking unavailable, using tap-to-spray", err);
    frontCameraReady = false;
    frontCameraError = `${err.name}: ${err.message}`;
  }

  if (previewGroup) scene.remove(previewGroup);

  try {
    await arSession.start();
  } catch (err) {
    console.error("Failed to start AR session", err);
    handTracker.stop();
    if (previewGroup) scene.add(previewGroup);
    arButton.disabled = false;
    arButton.textContent = "Enter AR";
    unsupportedNote.hidden = false;
    unsupportedNote.textContent = `Could not start AR: ${err.message}`;
  }
});

const clock = new THREE.Clock();
const _tmpViewMatrix = new THREE.Matrix4();

function animate(_time, frame) {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (frame) {
    arSession.update(frame);

    const referenceSpace = renderer.xr.getReferenceSpace();
    const viewerPose = referenceSpace ? frame.getViewerPose(referenceSpace) : null;
    const xrView = viewerPose?.views[0] ?? null;

    if (handTrackingMode === "pending" && xrView) {
      rawCameraTracker?.processFrame(frame, xrView);
      if (rawCameraTracker?.available) {
        handTrackingMode = "raw-camera";
      } else {
        rawCameraGraceFrames++;
        if (rawCameraGraceFrames > RAW_CAMERA_GRACE_FRAMES) {
          // Already running (started before the session, see the
          // ar-button handler) - just switch to using its signal.
          handTrackingMode = frontCameraReady ? "front-camera" : "touch-only";
        }
      }
    } else if (handTrackingMode === "raw-camera" && xrView) {
      rawCameraTracker?.processFrame(frame, xrView);
    }

    // Paint position: when the palm is tracked directly in the AR
    // camera feed, cast from it to the last known surface plane;
    // otherwise fall back to the screen-center hit-test reticle.
    let paintPose = arSession.latestHit;
    if (handTrackingMode === "raw-camera" && rawCameraTracker?.palmRay && arSession.latestHit) {
      const hitPoint = intersectRayPlane(
        rawCameraTracker.palmRay.origin,
        rawCameraTracker.palmRay.direction,
        arSession.latestHit.position,
        arSession.latestHit.normal,
      );
      if (hitPoint) {
        paintPose = { position: hitPoint, quaternion: arSession.latestHit.quaternion };
      }
    }

    reticle.visible = !!paintPose;
    if (paintPose) {
      reticle.position.copy(paintPose.position);
      reticle.quaternion.copy(paintPose.quaternion);
    }

    const spraying = isSpraying() && !!paintPose;
    if (spraying && !wasSpraying) {
      // Hand-tracked sessions (either mode) cue the rattle off picking
      // up the can / shaking it; only the touch-only fallback (no
      // camera at all) has no such signal, so give it a one-time
      // rattle on its very first spray instead.
      if (!isHandTrackingActive() && !hasPlayedFallbackRattle) {
        soundManager.playRattle();
        hasPlayedFallbackRattle = true;
      }
      soundManager.startHiss();
    } else if (!spraying && wasSpraying) {
      soundManager.stopHiss();
    }
    wasSpraying = spraying;

    spraySystem.update(dt, paintPose, spraying);

    if (heldCanGroup) {
      if (handTrackingMode === "raw-camera" && rawCameraTracker?.palmRay && xrView) {
        const worldPoint = rawCameraTracker.palmRay.origin
          .clone()
          .addScaledVector(rawCameraTracker.palmRay.direction, PALM_CAN_DISTANCE);
        _tmpViewMatrix.fromArray(xrView.transform.matrix).invert();
        heldCanGroup.position.copy(worldPoint.applyMatrix4(_tmpViewMatrix));
      } else {
        heldCanGroup.position.copy(HELD_CAN_HUD_POSITION);
      }

      const targetTilt = spraying ? -0.3 : 0;
      heldCanGroup.rotation.x = THREE.MathUtils.lerp(
        heldCanGroup.rotation.x,
        targetTilt,
        0.2,
      );
    }

    xrStatus.textContent = !paintPose
      ? "Move phone to find a surface"
      : spraying
        ? "Spraying…"
        : handTrackingMode === "raw-camera"
          ? "Pinch to spray"
          : "Pinch your free hand, or tap and hold, to spray";

    debugEl.textContent =
      `mode=${handTrackingMode} frontReady=${frontCameraReady}\n` +
      `raw: available=${!!rawCameraTracker?.available} handPresent=${!!rawCameraTracker?.handPresent} ` +
      `pinch=${!!rawCameraTracker?.isPinching} metric=${rawCameraTracker?.lastPinchMetric?.toFixed(2) ?? "-"}\n` +
      `rawErr=${rawCameraTracker?.lastError ?? "-"}\n` +
      `front: handPresent=${handTracker.handPresent} pinch=${handTracker.isPinching} ` +
      `metric=${handTracker.lastPinchMetric?.toFixed(2) ?? "-"}\n` +
      `frontErr=${frontCameraError ?? "-"}\n` +
      `touching=${isTouching} hasHit=${!!arSession.latestHit}`;
  } else if (previewGroup) {
    previewGroup.rotation.y += dt * 0.6;
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

async function loadEnvironmentMap() {
  const hdrTexture = await new RGBELoader().loadAsync("/textures/environment.hdr");
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  scene.environment = pmremGenerator.fromEquirectangular(hdrTexture).texture;
  hdrTexture.dispose();
  pmremGenerator.dispose();
}

// Loads spray_can.glb and normalizes it to a unit-scale, origin-centered
// model regardless of the source file's authoring units, so callers can
// derive their own scale/placement from a known, predictable size.
async function loadNormalizedCanModel() {
  const gltf = await new GLTFLoader().loadAsync("/models/spray_can.glb");
  const model = gltf.scene;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1 / maxDim;
  model.scale.setScalar(scale);

  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
  model.position.sub(center);

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius * scale;

  return { model, radius };
}

async function loadCanPreview() {
  const { model, radius } = await loadNormalizedCanModel();

  // Derive camera distance from the bounding sphere and the camera's
  // actual FOV rather than a hand-picked world-space size/distance pair
  // - that stays correct no matter what the model's real-world unit
  // scale turns out to be.
  const targetFraction = 0.28; // fraction of half-height the can should occupy
  const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
  const distance = radius / (targetFraction * Math.tan(fovRad));
  const halfHeightAtDistance = distance * Math.tan(fovRad);
  const verticalOffset = -0.45 * halfHeightAtDistance;

  previewGroup = new THREE.Group();
  previewGroup.add(model);
  previewGroup.position.set(0, verticalOffset, -distance);
  scene.add(previewGroup);
}

async function loadHeldCan() {
  const { model, radius } = await loadNormalizedCanModel();

  // Small HUD-style prop in the lower-right of view, like a
  // first-person held object, scaled to a fixed apparent size.
  const targetRadius = 0.045;
  model.scale.multiplyScalar(targetRadius / radius);

  heldCanGroup = new THREE.Group();
  heldCanGroup.add(model);
  heldCanGroup.position.copy(HELD_CAN_HUD_POSITION);
  heldCanGroup.rotation.set(0, Math.PI * 0.15, Math.PI * 0.08);
  heldCanGroup.visible = false;
  camera.add(heldCanGroup);
}

(async () => {
  const supported = await ArSession.isSupported();

  await Promise.allSettled([
    spraySystem.loadAssets(),
    loadEnvironmentMap(),
    loadCanPreview(),
    loadHeldCan(),
  ]);

  if (!supported) {
    arButton.textContent = "AR not supported";
    unsupportedNote.hidden = false;
    unsupportedNote.textContent =
      "This browser/device doesn't support WebXR immersive AR. Try Chrome on an ARCore-capable Android phone.";
    return;
  }

  arButton.disabled = false;
  arButton.textContent = "Enter AR";
})();
