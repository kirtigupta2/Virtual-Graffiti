import * as THREE from "three";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ArSession } from "./xr/ArSession.js";
import { HandTracker } from "./hands/HandTracker.js";
import { SpraySystem, SPRAY_COLORS } from "./graffiti/SpraySystem.js";
import { SoundManager } from "./audio/SoundManager.js";

const canvas = document.getElementById("app-canvas");
const startScreen = document.getElementById("start-screen");
const arButton = document.getElementById("ar-button");
const unsupportedNote = document.getElementById("unsupported-note");
const xrOverlay = document.getElementById("xr-overlay");
const xrStatus = document.getElementById("xr-status");
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
let handTrackingAvailable = false;
let hasPlayedFallbackRattle = false;

function isSpraying() {
  return isPinching || isTouching;
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
  onSessionStart: () => {
    startScreen.style.display = "none";
    xrOverlay.classList.add("active");
    xrStatus.textContent = "Move phone to find a surface";
    if (heldCanGroup) heldCanGroup.visible = true;
  },
  onSessionEnd: () => {
    handTracker.stop();
    soundManager.stopHiss();
    isPinching = false;
    isTouching = false;
    wasSpraying = false;
    handTrackingAvailable = false;
    hasPlayedFallbackRattle = false;
    reticle.visible = false;
    if (heldCanGroup) heldCanGroup.visible = false;

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

  try {
    await handTracker.start();
    handTrackingAvailable = true;
  } catch (err) {
    console.warn("Hand-tracking camera unavailable, using tap-to-spray", err);
    handTrackingAvailable = false;
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

function animate(_time, frame) {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (frame) {
    arSession.update(frame);
    reticle.visible = !!arSession.latestHit;
    if (arSession.latestHit) {
      reticle.position.copy(arSession.latestHit.position);
      reticle.quaternion.copy(arSession.latestHit.quaternion);
    }

    const spraying = isSpraying() && !!arSession.latestHit;
    if (spraying && !wasSpraying) {
      // Hand-tracked sessions cue the rattle off picking up the can /
      // shaking it (see handTracker's onHandDetected/onShake); only the
      // touch-only fallback (no camera) has no such signal, so give it
      // a one-time rattle on its very first spray instead.
      if (!handTrackingAvailable && !hasPlayedFallbackRattle) {
        soundManager.playRattle();
        hasPlayedFallbackRattle = true;
      }
      soundManager.startHiss();
    } else if (!spraying && wasSpraying) {
      soundManager.stopHiss();
    }
    wasSpraying = spraying;

    spraySystem.update(dt, arSession.latestHit, spraying);

    if (heldCanGroup) {
      const targetTilt = spraying ? -0.3 : 0;
      heldCanGroup.rotation.x = THREE.MathUtils.lerp(
        heldCanGroup.rotation.x,
        targetTilt,
        0.2,
      );
    }

    xrStatus.textContent = !arSession.latestHit
      ? "Move phone to find a surface"
      : spraying
        ? "Spraying…"
        : "Pinch your free hand, or tap and hold, to spray";
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
  heldCanGroup.position.set(0.13, -0.14, -0.3);
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
