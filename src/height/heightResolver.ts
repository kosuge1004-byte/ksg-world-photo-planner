import { Cartographic, Math as CesiumMath, type Cartesian3 } from "cesium";

import type { GroundPoint, ResolvedGroundPoint } from "../types/points";
import { isResolvedGroundPoint } from "../types/points";
import { groundPointFromCoordinates, fetchGsiGeoidHeight } from "../cesium/worldTerrain";
import {
  ValidationError,
  assertGroundPoint,
  assertLatitude,
  assertLongitude,
  heightResolutionFailureMessage,
} from "../validation/validationService";

export class HeightResolutionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "HeightResolutionError";
    this.cause = cause;
  }
}

/**
 * 2D入力（座標クリック・検索・GoogleMapsURL・共有URL・人物/三脚/被写体の
 * 手動座標指定）を唯一のDEM/ジオイド経路で解決する。
 */
export async function resolveGroundPoint(
  latitude: number,
  longitude: number,
  label: string
): Promise<ResolvedGroundPoint> {
  // 緯度経度の検証はValidationServiceに一本化する。
  try {
    assertLatitude(latitude, `${label}の緯度`);
    assertLongitude(longitude, `${label}の経度`);
  } catch (error) {
    throw new HeightResolutionError(
      error instanceof ValidationError ? error.message : `${label}の座標が不正です`,
      error
    );
  }
  let point: GroundPoint;
  try {
    point = await groundPointFromCoordinates(latitude, longitude, label);
  } catch (error) {
    throw new HeightResolutionError(heightResolutionFailureMessage(label), error);
  }
  if (!isResolvedGroundPoint(point)) {
    throw new HeightResolutionError(`${label}の高度基準を確定できませんでした`);
  }
  // 楕円体高・標高・範囲まで含めて最終検証する。
  try {
    assertGroundPoint(point, label);
  } catch (error) {
    throw new HeightResolutionError(
      error instanceof ValidationError ? error.message : `${label}の高度が不正です`,
      error
    );
  }
  return point;
}

/**
 * 3D入力（scene.pickPosition / clampToHeightMostDetailedが返した実表面の
 * Cartesian3）を唯一の経路で解決する。人物・三脚・被写体のいずれも、
 * 明示的な3D選択はこの関数だけを通す。楕円体高は3Dピック結果をそのまま
 * 採用し（それ自体が実表面の正確な楕円体高のため）、標高換算に必要な
 * ジオイド高だけを国土地理院APIから取得する。取得できなければ
 * 0mへフォールバックせず失敗させる。
 */
export async function resolveGroundPointFrom3dSurface(
  position: Cartesian3,
  label: string
): Promise<ResolvedGroundPoint> {
  const cartographic = Cartographic.fromCartesian(position);
  const ellipsoidalHeightMeters = cartographic.height;
  if (!Number.isFinite(ellipsoidalHeightMeters)) {
    throw new HeightResolutionError(`${label}の3D表面高度が不正です`);
  }
  let geoidHeightMeters: number;
  try {
    geoidHeightMeters = await fetchGsiGeoidHeight(cartographic);
  } catch (error) {
    throw new HeightResolutionError(heightResolutionFailureMessage(`${label}のジオイド高`), error);
  }
  const point: ResolvedGroundPoint = {
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    height: ellipsoidalHeightMeters,
    ellipsoidalHeightMeters,
    orthometricHeightMeters: ellipsoidalHeightMeters - geoidHeightMeters,
    geoidHeightMeters,
    heightSource: "3d-picked",
    label,
  };
  if (!isResolvedGroundPoint(point)) {
    throw new HeightResolutionError(`${label}の3D表面高度基準を確定できませんでした`);
  }
  try {
    assertGroundPoint(point, label);
  } catch (error) {
    throw new HeightResolutionError(
      error instanceof ValidationError ? error.message : `${label}の3D表面高度が不正です`,
      error
    );
  }
  return point;
}
