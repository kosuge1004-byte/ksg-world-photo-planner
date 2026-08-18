import { Cartesian3, Cartographic, Ellipsoid, Ray, type Scene, type Viewer } from "cesium";

import { fetchGsiGeoidHeight, groundPointFromCoordinates } from "./worldTerrain";
import { collectGoogleTilesetsToExclude } from "./googleTilesetMarker";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import type { ResolvedGroundPoint } from "../types/points";
import { isResolvedGroundPoint } from "../types/points";

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
// 鉄塔・電波塔のような鉄骨格子構造は、中心1点だけを垂直に狙うと隙間を
// 素通りして何にも当たらないことがある。周辺の複数点を試すことで、
// 手動での再指定を求めずに自動で建物（構造物）を捉えられるようにする。
const SAMPLING_OFFSETS_METERS = [0, 3, 6, 10];
const SAMPLING_BEARINGS_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];

export type PlateauBuildingHeightVerification = {
  /** 建物接地点の高さがGSI DEMと許容範囲内で一致したか。 */
  verified: boolean;
  /** 建物接地点の楕円体高とDEM楕円体高の差（参考値、m）。取得できない場合はnull。 */
  discrepancyMeters: number | null;
};

/**
 * 指定した経緯度直下でPLATEAU建物タイルセットに垂直レイを通し、その地点の
 * 全交点（Cartographic配列）を返す。地形（globe）は誤検出を避けるため
 * 一時的に隠す。交点が無い場合はnull（直下に建物がない、または壁を
 * 斜めから見ているだけ）。
 */
async function plateauVerticalRaycast(
  viewer: Viewer,
  longitude: number,
  latitude: number,
  signal?: AbortSignal
): Promise<Cartographic[] | null> {
  const scene = viewer.scene as RayPickingScene;
  if (typeof scene.drillPickFromRayMostDetailed !== "function") {
    return null;
  }

  const globe = scene.globe;
  const globeWasShown = globe?.show;
  if (globe) globe.show = false;
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
      // Googleタイルの形状データは遮蔽判定（この接地高さ検証を含む）に
      // 一切使わない（利用規約上の理由）。
      [...viewer.entities.values, ...collectGoogleTilesetsToExclude(viewer)],
      0.12
    );
  } catch (error) {
    console.warn("PLATEAU建物の交点を取得できませんでした", error);
    return null;
  } finally {
    if (globe) globe.show = globeWasShown ?? true;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const hits = intersections
    .filter((intersection): intersection is SceneRayIntersection & { position: Cartesian3 } =>
      intersection.position !== undefined)
    .map((intersection) => Cartographic.fromCartesian(intersection.position));
  return hits.length > 0 ? hits : null;
}

/**
 * 指定した経緯度直下でPLATEAU建物タイルセットに垂直レイを通し、
 * 最も低い交点（＝建物の接地部分）を求め、その地点のGSI DEM高度と
 * 突き合わせて検証する。
 */
export async function verifyPlateauBuildingBaseHeight(
  viewer: Viewer,
  longitude: number,
  latitude: number,
  signal?: AbortSignal
): Promise<PlateauBuildingHeightVerification> {
  const hits = await plateauVerticalRaycast(viewer, longitude, latitude, signal);
  if (!hits) {
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

/**
 * 標準モード用：被写体地点にPLATEAU建物があれば、その屋根面へ被写体高度を
 * 合わせる（高精度モードでGoogle 3D Tilesへクランプするのと同じ考え方）。
 * 全国一律の高さ補正はせず、その建物の接地点をGSI DEMと個別に検証できた
 * 場合だけ屋根高度を採用する。建物が無い・検証できない場合はnullを返し、
 * 呼び出し側は通常のDEM地面高度にフォールバックする。
 *
 * 中心点の真上だけでは、鉄塔・電波塔のような格子構造の隙間を素通りして
 * 何も検出できないことがあるため、中心点に加えて周辺の複数点も自動で
 * 試す。被写体自体の緯度経度（マーカー位置）は入力のまま変更せず、
 * 見つかった構造物の高さだけを採用する。
 */
export async function resolvePlateauRoofGroundPoint(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  label: string,
  signal?: AbortSignal
): Promise<ResolvedGroundPoint | null> {
  const origin = { latitude, longitude };
  const candidates: { latitude: number; longitude: number }[] = [origin];
  for (const offsetMeters of SAMPLING_OFFSETS_METERS.slice(1)) {
    for (const bearingDegrees of SAMPLING_BEARINGS_DEGREES) {
      const destination = calculateKarneyDestinationPoint(
        { latitude, longitude, height: 0, label },
        bearingDegrees,
        offsetMeters
      );
      candidates.push({ latitude: destination.latitude, longitude: destination.longitude });
    }
  }

  for (const candidate of candidates) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const hits = await plateauVerticalRaycast(viewer, candidate.longitude, candidate.latitude, signal);
    if (!hits) continue;
    const lowestHit = hits.reduce((lowest, current) =>
      current.height < lowest.height ? current : lowest
    );
    const highestHit = hits.reduce((highest, current) =>
      current.height > highest.height ? current : highest
    );

    let demGroundPoint;
    try {
      demGroundPoint = await groundPointFromCoordinates(
        candidate.latitude,
        candidate.longitude,
        `${label}の接地点検証用DEM`
      );
    } catch (error) {
      console.warn("PLATEAU建物検証用のDEM高度を取得できませんでした", error);
      continue;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const discrepancyMeters = lowestHit.height - demGroundPoint.height;
    if (Math.abs(discrepancyMeters) > BASE_HEIGHT_TOLERANCE_METERS) {
      // 接地点がDEMと大きくズレている＝この構造物の高さ基準は信頼できない。
      // この候補点は諦めて、次の候補点を試す。
      continue;
    }

    let geoidHeightMeters: number;
    try {
      geoidHeightMeters = await fetchGsiGeoidHeight(lowestHit);
    } catch (error) {
      console.warn(`${label}のジオイド高を取得できませんでした`, error);
      continue;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 被写体のマーカー位置（緯度経度）は入力のまま変更しない。
    // 見つかった構造物の高さだけを採用する。
    const ellipsoidalHeightMeters = highestHit.height;
    const point: ResolvedGroundPoint = {
      latitude: origin.latitude,
      longitude: origin.longitude,
      height: ellipsoidalHeightMeters,
      ellipsoidalHeightMeters,
      orthometricHeightMeters: ellipsoidalHeightMeters - geoidHeightMeters,
      geoidHeightMeters,
      heightSource: "3d-picked",
      label,
    };
    if (isResolvedGroundPoint(point)) return point;
  }

  return null;
}

export { BASE_HEIGHT_TOLERANCE_METERS };
