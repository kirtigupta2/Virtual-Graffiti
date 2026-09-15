import * as THREE from "three";

const SPAWN_INTERVAL_SECONDS = 0.09;
const MAX_DECALS = 400;
const DECAL_SIZE = 0.12;
const SURFACE_OFFSET = 0.002;

const SPRAY_COLORS = [0xff2d78, 0x2de8ff, 0xffe32d, 0x39ff6a, 0xffffff];

export class SpraySystem {
  constructor({ scene }) {
    this.scene = scene;

    this.decalMaterial = null;
    this.decals = [];
    this.spawnTimer = 0;
    this.colorIndex = 0;
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

  cycleColor() {
    this.colorIndex = (this.colorIndex + 1) % SPRAY_COLORS.length;
    if (this.decalMaterial) {
      this.decalMaterial = this.decalMaterial.clone();
      this.decalMaterial.color.setHex(SPRAY_COLORS[this.colorIndex]);
    }
  }

  /** Call once per frame with the current reticle hit pose (or null) and trigger state. */
  update(dt, hitPose, isSpraying) {
    if (!isSpraying || !hitPose) {
      this.spawnTimer = 0;
      return;
    }

    this.spawnTimer += dt;
    if (this.spawnTimer < SPAWN_INTERVAL_SECONDS) return;
    this.spawnTimer = 0;

    this._spawnDecal(hitPose);
  }

  _spawnDecal(hitPose) {
    if (!this.decalMaterial) return;

    const geometry = new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE);
    const mesh = new THREE.Mesh(geometry, this.decalMaterial);

    // Hit-test pose orientation's local +Y axis is the surface normal
    // (matches the standard WebXR reticle convention), so rotate the
    // plane to face +Y before applying that orientation.
    const jitterRadius = DECAL_SIZE * 0.6;
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
