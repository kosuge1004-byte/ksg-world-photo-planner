import { Observer } from "astronomy-engine";

import type { CameraSettings } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { orthometricHeightMeters, withLensCenterHeight } from "../types/points";
import { assertGroundPoint } from "../validation/validationService";

/**
 * ObserverFactory: Astronomy EngineのObserverを生成する唯一の場所。
 * 他の場所での `new Observer(...)` は禁止。
 *
 * 高度基準の使い分け:
 * - Astronomy Engine (Observer) → orthometricHeightMeters（標高＝平均海面基準）
 * - Cesium / ECEF                → ellipsoidalHeightMeters（楕円体高）
 *
 * Astronomy EngineのObserverは標高（海抜）を期待するため、必ず
 * `orthometricHeightMeters()` を通す。楕円体高をそのまま渡すと日本国内で
 * 約30〜40mの系統誤差になるため、この関数以外でObserverを作らないことで
 * 混在を防ぐ。
 */
export function createAstronomyObserver(point: GroundPoint): Observer {
  // ValidationServiceで緯度・経度・標高を検証してからAstronomy Engineへ渡す。
  assertGroundPoint(point, point?.label ?? "天体観測点");
  return new Observer(
    point.latitude,
    point.longitude,
    orthometricHeightMeters(point)
  );
}

/**
 * 三脚位置＋レンズ中心高で観測点Observerを作る。天体の視位置は
 * レンズ中心が基準になるため、プレビュー・軌跡・検索はこちらを使う。
 */
export function createAstronomyObserverAtLens(
  tripod: GroundPoint,
  settings: CameraSettings
): Observer {
  return createAstronomyObserver(
    withLensCenterHeight(tripod, settings.lensCenterHeightMeters)
  );
}
