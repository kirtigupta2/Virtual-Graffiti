import * as THREE from "three";

const MAX_DECALS = 600;
const DECAL_SIZE = 0.12;
const SURFACE_OFFSET = 0.002;

// Spacing between stamps along a stroke, and how often to dab while
// the reticle holds still - both drive continuous-looking coverage
// instead of a timer-only stamp rate that leaves gaps when the phone
// pans faster than the stamp interval.
const STEP_DISTANCE = DECAL_SIZE * 0.45;
const IDLE_DAB_INTERVAL = 0.12;
// A jump this large between frames means the hit-test re-acquired a
// new spot (surface lost and found elsewhere) rather than the user
// dragging across a surface, so don't bridge a line across it.
const MAX_BRIDGE_DISTANCE = 0.4;

export const SPRAY_COLORS = [0xff2d78, 0x2de8ff, 0xffe32d, 0x39ff6a, 0xffffff];

export class SpraySystem {
  constructor({ scene }) {
    this.scene = scene;

    this.decalMaterial = null;
    this.decals = [];
    this.colorIndex = 0;

    this._lastStampPos = null;
    this._lastStampQuat = null;
    this._idleTimer = 0;
  }

  async loadAssets() {
    const textureLoader = new THREE.TextureLoader();
    const splatTexture = await textureLoader.loadAsync(
      "/textures/brush_splat.png",
    );
    splatTexture.colorSpace = THREE.SRGBColorSpace;

    this.decalMaterial = new THREE.MeshBasicMaterial({
      map: splatTexture,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      color: SPRAY_COLORS[this.colorIndex],
      side: THREE.DoubleSide,
    });
  }

  setColorIndex(index) {
    this.colorIndex = index;
    if (this.decalMaterial) {
      this.decalMaterial = this.decalMaterial.clone();
      this.decalMaterial.color.setHex(SPRAY_COLORS[this.colorIndex]);
    }
  }

  /** Call once per frame with the current reticle hit pose (or null) and trigger state. */
  update(dt, hitPose, isSpraying) {
    if (!isSpraying || !hitPose) {
      this._lastStampPos = null;
      this._lastStampQuat = null;
      this._idleTimer = 0;
      return;
    }

    if (!this._lastStampPos) {
      this._spawnDecal(hitPose);
      this._lastStampPos = hitPose.position.clone();
      this._lastStampQuat = hitPose.quaternion.clone();
      this._idleTimer = 0;
      return;
    }

    const dist = this._lastStampPos.distanceTo(hitPose.position);

    if (dist > MAX_BRIDGE_DISTANCE) {
      this._spawnDecal(hitPose);
      this._lastStampPos.copy(hitPose.position);
      this._lastStampQuat.copy(hitPose.quaternion);
      this._idleTimer = 0;
      return;
    }

    if (dist >= STEP_DISTANCE) {
      const steps = Math.ceil(dist / STEP_DISTANCE);
      const stepPos = new THREE.Vector3();
      const stepQuat = new THREE.Quaternion();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        stepPos.lerpVectors(this._lastStampPos, hitPose.position, t);
        stepQuat.copy(this._lastStampQuat).slerp(hitPose.quaternion, t);
        this._spawnDecal({ position: stepPos, quaternion: stepQuat });
      }
      this._lastStampPos.copy(hitPose.position);
      this._lastStampQuat.copy(hitPose.quaternion);
      this._idleTimer = 0;
      return;
    }

    this._idleTimer += dt;
    if (this._idleTimer >= IDLE_DAB_INTERVAL) {
      this._spawnDecal(hitPose);
      this._idleTimer = 0;
    }
  }

  _spawnDecal(hitPose) {
    if (!this.decalMaterial) return;

    const geometry = new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE);
    const mesh = new THREE.Mesh(geometry, this.decalMaterial);

    // Hit-test pose orientation's local +Y axis is the surface normal
    // (matches the standard WebXR reticle convention), so rotate the
    // plane to face +Y before applying that orientation.
    const jitterRadius = DECAL_SIZE * 0.3;
    const jitterX = (Math.random() - 0.5) * jitterRadius;
    const jitterZ = (Math.random() - 0.5) * jitterRadius;

    mesh.position.copy(hitPose.position);
    mesh.quaternion.copy(hitPose.quaternion);
    mesh.translateX(jitterX);
    mesh.translateZ(jitterZ);
    mesh.translateY(SURFACE_OFFSET);
    mesh.rotateX(-Math.PI / 2);
    mesh.rotateZ(Math.random() * Math.PI * 2);

    const scale = 0.7 + Math.random() * 0.7;
    mesh.scale.setScalar(scale);

    this.scene.add(mesh);
    this.decals.push(mesh);

    if (this.decals.length > MAX_DECALS) {
      const old = this.decals.shift();
      this.scene.remove(old);
      old.geometry.dispose();
    }
  }

  clear() {
    for (const decal of this.decals) {
      this.scene.remove(decal);
      decal.geometry.dispose();
    }
    this.decals = [];
  }
}
