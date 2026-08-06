import { assertFovDegrees } from "../validation/validationService";

const DEG = Math.PI / 180;

/**
 * 3成分ベクトル。CesiumのCartesian3（x,y,z）と構造的に互換なので、
 * ECEF基底の投影ではCartesian3をそのまま渡せる。ENU（east/north/up）方向は
 * `localVectorToVec3()` で変換してから渡す。
 */
export type Vec3 = { x: number; y: number; z: number };

export type LocalVector = { east: number; north: number; up: number };

export function localVectorToVec3(vector: LocalVector): Vec3 {
  return { x: vector.east, y: vector.north, z: vector.up };
}

/**
 * カメラの投影基底。人物・被写体・天体・画角・軌跡・最終判定のすべてが
 * この形へ変換した上で `projectToScreen()` / `projectDirectionToPlane()` を
 * 経由する。right/up/forwardとdirectionは同じ座標系（ECEFまたはENU）で
 * 揃えること。
 */
export type ProjectionBasis = {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  horizontalFovDegrees: number;
  verticalFovDegrees: number;
};

export type PlaneProjection = {
  x: number;
  y: number;
  inFront: boolean;
};

export type ScreenProjection = {
  xPercent: number;
  yPercent: number;
  inFront: boolean;
  visibleInFrame: boolean;
};

/**
 * 方位角・仰角からローカルENU（east/north/up）方向ベクトルを求める。
 * `directionToHorizontalDegrees()`の逆変換にあたる、唯一の実装。
 * 天体・カメラ・LOS方向ベクトル生成はすべてこの関数を経由する。
 */
export function horizontalDirectionToVec3(azimuthDegrees: number, altitudeDegrees: number): Vec3 {
  const azimuth = azimuthDegrees * DEG;
  const altitude = altitudeDegrees * DEG;
  const horizontalLength = Math.cos(altitude);
  return {
    x: horizontalLength * Math.sin(azimuth),
    y: horizontalLength * Math.cos(azimuth),
    z: Math.sin(altitude),
  };
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * ローカルENU（east/north/up）系の方向ベクトルから方位角・仰角を求める。
 * `horizontalDirection()`（celestial.ts）の逆変換にあたる、唯一の実装。
 * LOS判定（celestialOcclusion.ts）を含め、方向ベクトル→方位/仰角の変換は
 * すべてこの関数を経由する。
 */
export function directionToHorizontalDegrees(direction: Vec3): {
  azimuthDegrees: number;
  altitudeDegrees: number;
} {
  const azimuthDegrees = ((Math.atan2(direction.x, direction.y) * 180) / Math.PI + 360) % 360;
  const altitudeDegrees = (Math.asin(Math.max(-1, Math.min(1, direction.z))) * 180) / Math.PI;
  return { azimuthDegrees, altitudeDegrees };
}

/**
 * 中心投影（ピンホールカメラ）で方向ベクトルを像平面座標へ変換する。
 * 画角(FOV)には依存しない、Projection層の幾何学的な核となる関数。
 */
export function projectDirectionToPlane(direction: Vec3, basis: ProjectionBasis): PlaneProjection {
  const forwardDistance = dot3(direction, basis.forward);
  if (!Number.isFinite(forwardDistance) || forwardDistance <= 1e-8) {
    return { x: 0, y: 0, inFront: false };
  }
  return {
    x: dot3(direction, basis.right) / forwardDistance,
    // 画像座標は下向きを正にする。
    y: -dot3(direction, basis.up) / forwardDistance,
    inFront: true,
  };
}

/**
 * 唯一の画面座標変換関数。人物・被写体・天体・画角境界・軌跡・最終構図判定は
 * すべてこの関数を経由する。実カメラと同じ中心投影で0-100%のプレビュー座標
 * （xPercent, yPercent）を返す。
 */
export function projectToScreen(direction: Vec3, basis: ProjectionBasis): ScreenProjection {
  // 画角が0または180度以上だとtanが発散し画面座標が不定になるため、
  // ValidationServiceで先に停止する。
  assertFovDegrees(basis.horizontalFovDegrees, "投影の水平画角");
  assertFovDegrees(basis.verticalFovDegrees, "投影の垂直画角");
  const plane = projectDirectionToPlane(direction, basis);
  const xPercent = 50 + 50 * plane.x / Math.tan(basis.horizontalFovDegrees * DEG / 2);
  const yPercent = 50 + 50 * plane.y / Math.tan(basis.verticalFovDegrees * DEG / 2);
  const visibleInFrame =
    plane.inFront &&
    Number.isFinite(xPercent) &&
    Number.isFinite(yPercent) &&
    xPercent >= 0 && xPercent <= 100 &&
    yPercent >= 0 && yPercent <= 100;
  return { xPercent, yPercent, inFront: plane.inFront, visibleInFrame };
}
