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

/**
 * `projectToScreen()`の逆変換。画面座標（0-100%）から、カメラ原点を基準とした
 * 方向ベクトルを求める。奥行きの情報は持たないため、そのままでは3D位置は
 * 定まらない——`positionOnPlaneAtDistance()`と組み合わせて使う。
 */
export function screenToDirection(
  xPercent: number,
  yPercent: number,
  basis: ProjectionBasis
): Vec3 {
  assertFovDegrees(basis.horizontalFovDegrees, "投影の水平画角");
  assertFovDegrees(basis.verticalFovDegrees, "投影の垂直画角");
  const planeX = ((xPercent - 50) / 50) * Math.tan(basis.horizontalFovDegrees * DEG / 2);
  const planeY = ((yPercent - 50) / 50) * Math.tan(basis.verticalFovDegrees * DEG / 2);
  // projectDirectionToPlane()のy軸反転（下向きを正にする）を元に戻す。
  return {
    x: basis.forward.x + planeX * basis.right.x - planeY * basis.up.x,
    y: basis.forward.y + planeX * basis.right.y - planeY * basis.up.y,
    z: basis.forward.z + planeX * basis.right.z - planeY * basis.up.z,
  };
}

/**
 * カメラ原点から`direction`（`screenToDirection()`の戻り値。forward成分が
 * ちょうど1になるよう構成されている）の向きへ、カメラ前方距離
 * `forwardDistanceMeters`だけ進んだ3D位置を返す。
 *
 * プレビュー画面は静止画像であり、任意の画面上の点（特に空中・空）に
 * 実際の3D表面があるとは限らない。そのため、被写体と同じカメラ前方距離
 * （＝被写体の奥行き平面）にあると仮定して2点間の実距離を近似する
 * ——望遠鏡で空中の2点を見比べるのと同じ考え方。
 */
export function positionOnPlaneAtDistance(
  origin: Vec3,
  direction: Vec3,
  forwardDistanceMeters: number
): Vec3 {
  return {
    x: origin.x + direction.x * forwardDistanceMeters,
    y: origin.y + direction.y * forwardDistanceMeters,
    z: origin.z + direction.z * forwardDistanceMeters,
  };
}
