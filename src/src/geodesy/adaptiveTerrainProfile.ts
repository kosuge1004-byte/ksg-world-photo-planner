import { Cartesian3, Cartographic, Ellipsoid } from "cesium";

import { terrestrialRefractionCorrectionDegrees } from "./terrestrialRefraction";

/**
 * 地形プロファイル走査（LOS: Line of Sight）の共通アルゴリズム。
 *
 * これまでクライアント (src/cesium/celestialOcclusion.ts) とサーバー
 * (server/celestialTerrainVisibility.ts) に、ほぼ同一のロジックが
 * 個別に実装されていた。片方だけ修正されもう片方が取り残される事故
 * （実際に地表屈折補正で発生した）を防ぐため、ここへ一本化する。
 *
 * サンプリング間隔は固定ではなく、観測点からの距離に応じて対数的に
 * 疎密を変える「Adaptive Step」を採用している。観測点に近いほど
 * 1mの距離変化が仰角に与える影響が大きいため密に、遠いほど疎に
 * サンプリングすることで、同じサンプル数でも遠距離の稜線を粗く
 * 見落とすことなく、近距離の障害物も取りこぼしにくくしている。
 * 粗い走査で最大仰角の位置を見つけた後、その前後だけを均等間隔で
 * 再走査する2段階方式で、全区間を細かく走査するより大幅に高速。
 */

export type TerrainProfilePoint = {
  distanceMeters: number;
  point: Cartographic;
};

export type TerrainProfileMaximum = {
  maximumElevationDegrees: number;
  distanceMeters: number;
  index: number;
};

const COARSE_SAMPLE_COUNT = 112;
const REFINE_SAMPLE_COUNT = 48;
const MINIMUM_DISTANCE_METERS = 8;

/**
 * 観測点からの距離を対数間隔で分割する（Adaptive Step、粗走査用）。
 */
export function adaptiveCoarseDistances(
  maximumDistanceMeters: number,
  sampleCount = COARSE_SAMPLE_COUNT
): number[] {
  const maximum = Math.max(MINIMUM_DISTANCE_METERS, maximumDistanceMeters);
  const distances = new Array<number>(sampleCount);
  const ratio = maximum / MINIMUM_DISTANCE_METERS;
  const denominator = Math.max(1, sampleCount - 1);
  for (let index = 0; index < sampleCount; index += 1) {
    distances[index] = MINIMUM_DISTANCE_METERS * ratio ** (index / denominator);
  }
  return distances;
}

/**
 * 粗走査で見つかった最大仰角の前後だけを均等間隔で再走査する
 * （Adaptive Step、精密走査用）。
 */
export function adaptiveRefinementDistances(
  distances: number[],
  maximumIndex: number,
  sampleCount = REFINE_SAMPLE_COUNT
): number[] {
  const start = distances[Math.max(0, maximumIndex - 2)];
  const end = distances[Math.min(distances.length - 1, maximumIndex + 2)];
  const refined = new Array<number>(sampleCount);
  const span = end - start;
  const denominator = Math.max(1, sampleCount - 1);
  for (let index = 0; index < sampleCount; index += 1) {
    refined[index] = start + span * index / denominator;
  }
  return refined;
}

export function elevationAngleDegrees(
  origin: Cartesian3,
  localUp: Cartesian3,
  target: Cartesian3
): number {
  const direction = Cartesian3.subtract(target, origin, new Cartesian3());
  if (Cartesian3.magnitudeSquared(direction) < 1e-6) return -90;
  Cartesian3.normalize(direction, direction);
  return Math.asin(
    Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp)))
  ) * 180 / Math.PI;
}

/**
 * 地表屈折補正込みで、プロファイル中の最大仰角点を求める。
 */
export function terrainProfileMaximum(
  origin: Cartesian3,
  distances: number[],
  samples: Cartographic[]
): TerrainProfileMaximum {
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cartesian3());
  // Phase6-1: LOS走査の各サンプルでCartesian3を新規生成しない。
  // 160点前後 × 多数候補の検索で発生していた短命オブジェクトを削減し、
  // GC停止時間とメモリピークを抑える。
  const target = new Cartesian3();
  const direction = new Cartesian3();
  let maximumElevationDegrees = -90;
  let maximumIndex = 0;
  const count = Math.min(samples.length, distances.length);
  for (let index = 0; index < count; index += 1) {
    const sample = samples[index];
    Cartesian3.fromRadians(
      sample.longitude,
      sample.latitude,
      Number.isFinite(sample.height) ? sample.height : 0,
      Ellipsoid.WGS84,
      target
    );
    Cartesian3.subtract(target, origin, direction);
    const magnitudeSquared = Cartesian3.magnitudeSquared(direction);
    const geometricElevationDegrees = magnitudeSquared < 1e-6
      ? -90
      : Math.asin(Math.max(-1, Math.min(1,
          Cartesian3.dot(direction, localUp) / Math.sqrt(magnitudeSquared)
        ))) * 180 / Math.PI;
    const elevation =
      geometricElevationDegrees +
      terrestrialRefractionCorrectionDegrees(distances[index]);
    if (elevation > maximumElevationDegrees) {
      maximumElevationDegrees = elevation;
      maximumIndex = index;
    }
  }
  return {
    maximumElevationDegrees,
    distanceMeters: distances[maximumIndex],
    index: maximumIndex,
  };
}

/**
 * 粗走査→精密走査の2段階Adaptive Stepで地形プロファイルの最大仰角点を求める。
 * sampleProfile は、距離配列に対応する地表座標を取得する非同期関数（DEM取得等）を渡す。
 */
export async function scanAdaptiveTerrainProfile(
  origin: Cartesian3,
  maximumDistanceMeters: number,
  sampleProfile: (distances: number[]) => Promise<Cartographic[]>
): Promise<TerrainProfileMaximum> {
  const coarseDistances = adaptiveCoarseDistances(maximumDistanceMeters);
  const coarseSamples = await sampleProfile(coarseDistances);
  const coarseMaximum = terrainProfileMaximum(origin, coarseDistances, coarseSamples);

  const refinedDistances = adaptiveRefinementDistances(coarseDistances, coarseMaximum.index);
  const refinedSamples = await sampleProfile(refinedDistances);
  const refinedMaximum = terrainProfileMaximum(origin, refinedDistances, refinedSamples);

  return refinedMaximum.maximumElevationDegrees > coarseMaximum.maximumElevationDegrees
    ? refinedMaximum
    : coarseMaximum;
}
