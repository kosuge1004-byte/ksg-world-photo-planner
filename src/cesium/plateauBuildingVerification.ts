import { Cartesian3, Cartographic, Ellipsoid, Ray, type Scene, type Viewer } from "cesium";

import { groundPointFromCoordinates } from "./worldTerrain";

/**
 * PLATEAU建物3Dは標準モードの3Dマップに表示専用として読み込まれているが、
 * 全国複合タイルセットのため地域によってジオイド・高さ基準のズレがあり、
 * 過去に全国一律の補正を試みて撤回した経緯がある
 * （PLATEAU_HEIGHT_CORRECTION_REMOVAL_20260806.md参照）。
 *
 * このモジュールは全国一律の補正を行わず、遮蔽判定でPLATEAU建物と
 * 交差した「その地点」だけを対象に、建物の接地高さをGSI DEMと個別に
 * 突き合わせて検証する。ズレが許容範囲内の建物だけを「確認済み」として
 * 遮蔽判定に使い、検証できない・ズレが大きい建物は未確認のまま扱う
 * （0mフォールバックや全国一律補正はしない）。
 */

type SceneRayIntersection = {
  object?: unknown;
  position?: Cartesian3;
};

type RayPickingScene = Scene & {
  drillPickFromRayMostDetailed?: (
    ray: Ray,
    limit?: number,
    objectsToExclude?: unknown[],
    width?: number
  ) => Promise<SceneRayIntersection[]>;
};

/** 接地高さの許容誤差。地下部分・DEM解像度による差を吸収する。 */
const BASE_HEIGHT_TOLERANCE_METERS = 5;
const VERTICAL_SEARCH_ALTITUDE_METERS = 3000;

export type PlateauBuildingHeightVerification = {
  /** 建物接地点の高さがGSI DEMと許容範囲内で一致したか。 */
  verified: boolean;
  /** 建物接地点の楕円体高とDEM楕円体高の差（参考値、m）。取得できない場合はnull。 */
  discrepancyMeters: number | null;
};

/**
 * 指定した経緯度直下でPLATEAU建物タイルセットに垂直レイを通し、
 * 最も低い交点（＝建物の接地部分）を求め、その地点のGSI DEM高度と
 * 突き合わせて検証する。地形（globe）は誤検出を避けるため一時的に隠す。
 */
export async function verifyPlateauBuildingBaseHeight(
  viewer: Viewer,
  longitude: number,
  latitude: number,
  signal?: AbortSignal
): Promise<PlateauBuildingHeightVerification> {
  const scene = viewer.scene as RayPickingScene;
  if (typeof scene.drillPickFromRayMostDetailed !== "function") {
    return { verified: false, discrepancyMeters: null };
  }

  const globeWasShown = scene.globe.show;
  scene.globe.show = false;
  let intersections: SceneRayIntersection[];
  try {
    const origin = Cartesian3.fromDegrees(
      longitude,
      latitude,
      VERTICAL_SEARCH_ALTITUDE_METERS
    );
    const down = Cartesian3.negate(
      Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cartesian3()),
      new Cartesian3()
    );
    intersections = await scene.drillPickFromRayMostDetailed.call(
      scene,
      new Ray(origin, down),
      32,
      [...viewer.entities.values],
      0.12
    );
  } catch (error) {
    console.warn("PLATEAU建物の接地点を取得できませんでした", error);
    return { verified: false, discrepancyMeters: null };
  } finally {
    scene.globe.show = globeWasShown;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const hits = intersections
    .filter((intersection): intersection is SceneRayIntersection & { position: Cartesian3 } =>
      intersection.position !== undefined)
    .map((intersection) => Cartographic.fromCartesian(intersection.position));
  if (hits.length === 0) {
    // 直下に建物がない（壁を斜めから見ているだけ等）。この地点では検証できない。
    return { verified: false, discrepancyMeters: null };
  }
  const lowestHit = hits.reduce((lowest, current) =>
    current.height < lowest.height ? current : lowest
  );

  let demGroundPoint;
  try {
    demGroundPoint = await groundPointFromCoordinates(
      latitude,
      longitude,
      "PLATEAU建物接地点の検証用DEM"
    );
  } catch (error) {
    console.warn("PLATEAU建物検証用のDEM高度を取得できませんでした", error);
    return { verified: false, discrepancyMeters: null };
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const discrepancyMeters = lowestHit.height - demGroundPoint.height;
  return {
    verified: Math.abs(discrepancyMeters) <= BASE_HEIGHT_TOLERANCE_METERS,
    discrepancyMeters,
  };
}

export { BASE_HEIGHT_TOLERANCE_METERS };
