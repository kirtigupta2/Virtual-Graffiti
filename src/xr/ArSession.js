import * as THREE from "three";

/**
 * Wraps a WebXR "immersive-ar" session: hit-test against real-world
 * surfaces (markerless, ARCore plane/depth detection under the hood) and
 * a screen-tap "select" fallback for devices/browsers without a usable
 * hand-tracking camera stream.
 */
export class ArSession {
  constructor({
    renderer,
    overlayRoot,
    onSessionStart,
    onSessionEnd,
    onSelectStart,
    onSelectEnd,
  }) {
    this.renderer = renderer;
    this.overlayRoot = overlayRoot;
    this.onSessionStart = onSessionStart;
    this.onSessionEnd = onSessionEnd;
    this.onSelectStart = onSelectStart;
    this.onSelectEnd = onSelectEnd;

    this.session = null;
    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.localSpace = null;

    /** Latest hit-test pose (world position + orientation), or null. */
    this.latestHit = null;
  }

  static async isSupported() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  async start() {
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local"],
      // camera-access is optional: an experimental, permission-gated
      // module (shipped Chrome ~M107) not guaranteed on every browser,
      // so we feature-detect per-frame (view.camera) rather than
      // require it, and fall back to front-camera tracking if absent.
      optionalFeatures: ["dom-overlay", "camera-access"],
      domOverlay: { root: this.overlayRoot },
    });

    this.session = session;
    this.hitTestSourceRequested = false;
    this.hitTestSource = null;

    this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(session);

    this.localSpace = this.renderer.xr.getReferenceSpace();

    session.addEventListener("selectstart", () => {
      if (this.onSelectStart) this.onSelectStart();
    });
    session.addEventListener("selectend", () => {
      if (this.onSelectEnd) this.onSelectEnd();
    });

    session.addEventListener("end", () => {
      this.session = null;
      this.hitTestSource = null;
      this.latestHit = null;
      if (this.onSessionEnd) this.onSessionEnd();
    });

    if (this.onSessionStart) this.onSessionStart(session);
  }

  async end() {
    if (this.session) await this.session.end();
  }

  /** Call once per rendered XR frame from renderer.setAnimationLoop. */
  update(frame) {
    if (!frame) return;
    const session = frame.session;

    if (!this.hitTestSourceRequested) {
      this.hitTestSourceRequested = true;
      session.requestReferenceSpace("viewer").then((viewerSpace) => {
        session
          .requestHitTestSource({ space: viewerSpace })
          .then((source) => {
            this.hitTestSource = source;
          })
          .catch(() => {
            this.hitTestSource = null;
          });
      });
    }

    if (!this.hitTestSource) {
      this.latestHit = null;
      return;
    }

    const results = frame.getHitTestResults(this.hitTestSource);
    if (results.length === 0) {
      this.latestHit = null;
      return;
    }

    const pose = results[0].getPose(this.localSpace);
    if (!pose) {
      this.latestHit = null;
      return;
    }

    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    m.decompose(position, quaternion, scale);

    // The hit-test pose's local +Y axis is the surface normal (the
    // standard WebXR reticle convention).
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);

    this.latestHit = { position, quaternion, matrix: m, normal };
  }
}
