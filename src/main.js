import * as THREE from "three";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ArSession } from "./xr/ArSession.js";
import { HandTracker } from "./hands/HandTracker.js";
import { SpraySystem } from "./graffiti/SpraySystem.js";
import { SoundManager } from "./audio/SoundManager.js";

const canvas = document.getElementById("app-canvas");
const startScreen = document.getElementById("start-screen");
const arButton = document.getElementById("ar-button");
const unsupportedNote = document.getElementById("unsupported-note");
const xrOverlay = document.getElementById("xr-overlay");
const xrStatus = document.getElementById("xr-status");
const xrExitButton = document.getElementById("xr-exit");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  20,
);

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

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const spraySystem = new SpraySystem({ scene });
const soundManager = new SoundManager();

let isPinching = false;
let isTouching = false;
let wasSpraying = false;

function isSpraying() {
  return isPinching || isTouching;
}

const handTracker = new HandTracker({
  onPinchChange: (pinching) => {
    isPinching = pinching;
  },
});

const arSession = new ArSession({
  renderer,
  overlayRoot: xrOverlay,
  onSessionStart: () => {
    startScreen.style.display = "none";
    xrOverlay.classList.add("active");
    xrStatus.textContent = "Move phone to find a surface";
  },
  onSessionEnd: () => {
    handTracker.stop();
    soundManager.stopHiss();
    isPinching = false;
    isTouching = false;
    wasSpraying = false;
    reticle.visible = false;

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
  } catch (err) {
    console.warn("Hand-tracking camera unavailable, using tap-to-spray", err);
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
      soundManager.playRattle();
      soundManager.startHiss();
    } else if (!spraying && wasSpraying) {
      soundManager.stopHiss();
    }
    wasSpraying = spraying;

    spraySystem.update(dt, arSession.latestHit, spraying);

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

async function loadCanPreview() {
  const gltf = await new GLTFLoader().loadAsync("/models/spray_can.glb");
  const model = gltf.scene;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 0.22 / maxDim;
  model.scale.setScalar(scale);

  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
  model.position.sub(center);

  previewGroup = new THREE.Group();
  previewGroup.add(model);
  previewGroup.position.set(0, -0.55, -1.4);
  scene.add(previewGroup);
}

(async () => {
  const supported = await ArSession.isSupported();

  await Promise.allSettled([
    spraySystem.loadAssets(),
    loadEnvironmentMap(),
    loadCanPreview(),
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
