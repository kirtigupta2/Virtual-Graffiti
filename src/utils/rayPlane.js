import * as THREE from "three";

/**
 * Intersects a ray with a plane defined by a point and normal.
 * Returns a new THREE.Vector3, or null if the ray is parallel to the
 * plane or points away from it.
 */
export function intersectRayPlane(rayOrigin, rayDirection, planePoint, planeNormal) {
  const denom = rayDirection.dot(planeNormal);
  if (Math.abs(denom) < 1e-6) return null;

  const diff = new THREE.Vector3().subVectors(planePoint, rayOrigin);
  const t = diff.dot(planeNormal) / denom;
  if (t <= 0) return null;

  return rayOrigin.clone().addScaledVector(rayDirection, t);
}
