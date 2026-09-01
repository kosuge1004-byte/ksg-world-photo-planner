import { Cartesian3, Cartographic, Ellipsoid, Ray, type Scene, type Viewer } from "cesium";

import { fetchGsiGeoidHeight, groundPointFromCoordinates } from "./worldTerrain";
import { collectGoogleTilesetsToExclude } from "./googleTilesetMarker";
import { clampToHeightWithTimeout } from "./clampToHeightWithTimeout";
import { withOverallTimeout } from "../utils/withOverallTimeout";
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

type RaycastHit = {
  cartographic: Cartographic;
  feature: unknown;
};

type RayPickingScene = Scene & {
  drillPickFromRayMostDetailed?: (
    ray: Ray,
    limit?: number,
    objectsToExclude?: unknown[],
    width?: number
  ) => Promise<SceneRayIntersection[]>;
};

type ClampHeightScene = Scene & {
  clampToHeightMostDetailed?: (
    cartesians: Cartesian3[],
    objectsToExclude?: object[],
    width?: number
  ) => Promise<(Cartesian3 | undefined)[]>;
};

/** 接地高さの許容誤差。地下部分・DEM解像度による差を吸収する。
 * 遮蔽判定の検証（verifyPlateauBuildingBaseHeight）にのみ使う値で、
 * 被写体の屋根合わせ（resolvePlateauRoofGroundPoint）には使わない。 */
const BASE_HEIGHT_TOLERANCE_METERS = 5;
/**
 * 被写体を建物・塔の頂上に合わせる際に許容する構造物高の上限。
 * 旧実装の120m固定上限では東京スカイツリー（634m）など正規の高塔まで
 * 異常値として除外していた。ここでは検索座標近傍（最大50m）のPLATEAU表面
 * だけを候補にしているため、水平距離で無関係な構造物を制限したうえで、
 * 日本の超高層建築・塔を十分包含する1000mまでを有効な構造物高として扱う。
 * 1000m超は高さ基準ずれ・破損タイル等の粗大異常として除外する。
 */
const MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS = 1000;
const VERTICAL_SEARCH_ALTITUDE_METERS = 3000;
// Stage 2（局所探索）の範囲。一般的な建物の輪郭に収まる規模とし、
// 隣接する別の建物・山など無関係に高い構造物へ誤って飛び移らないようにする。
const LOCAL_SEARCH_OFFSETS_METERS = [0, 5, 10, 15, 20];
// Stage 2で何も見つからない場合だけ試す、鉄塔・電波塔向けの広域フォール
// バック（脚部が中心から数十m離れて広がる格子構造で、局所探索の範囲内には
// 何も無いことがあるため）。
const WIDE_FALLBACK_OFFSETS_METERS = [30, 50];
const SAMPLING_BEARINGS_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];
// Stage 3（精密探索）の範囲。Stage 2で見つかった頂上候補の直近だけを、
// より細かい角度刻みで探る。
const REFINE_OFFSETS_METERS = [1, 3, 6];
const REFINE_BEARINGS_DEGREES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

export type PlateauBuildingHeightVerification = {
  /** 建物接地点の高さがGSI DEMと許容範囲内で一致したか。 */
  verified: boolean;
  /** 建物接地点の楕円体高とDEM楕円体高の差（参考値、m）。取得できない場合はnull。 */
  discrepancyMeters: number | null;
};

/**
 * 指定した経緯度直下でPLATEAU建物タイルセットに垂直レイを通し、その地点の
 * 全交点（Cartographicとフィーチャー参照）を返す。地形（globe）は誤検出を
 * 避けるため一時的に隠す。交点が無い場合はnull（直下に建物がない、または
 * 壁を斜めから見ているだけ）。
 */
async function plateauVerticalRaycast(
  viewer: Viewer,
  longitude: number,
  latitude: number,
  signal?: AbortSignal
): Promise<RaycastHit[] | null> {
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
    .map((intersection) => ({
      cartographic: Cartographic.fromCartesian(intersection.position),
      feature: intersection.object,
    }));
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
    current.cartographic.height < lowest.cartographic.height ? current : lowest
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

  const discrepancyMeters = lowestHit.cartographic.height - demGroundPoint.height;
  return {
    verified: Math.abs(discrepancyMeters) <= BASE_HEIGHT_TOLERANCE_METERS,
    discrepancyMeters,
  };
}

type CandidatePoint = { latitude: number; longitude: number };

function ringCandidates(
  origin: CandidatePoint,
  offsetsMeters: number[],
  bearingsDegrees: number[],
  label: string
): CandidatePoint[] {
  const points: CandidatePoint[] = [];
  for (const offsetMeters of offsetsMeters) {
    for (const bearingDegrees of bearingsDegrees) {
      const destination = calculateKarneyDestinationPoint(
        { latitude: origin.latitude, longitude: origin.longitude, height: 0, label },
        bearingDegrees,
        offsetMeters
      );
      points.push({ latitude: destination.latitude, longitude: destination.longitude });
    }
  }
  return points;
}

type ClampedCandidate = {
  point: CandidatePoint;
  cartographic: Cartographic;
};

/**
 * 候補地点群をまとめて1回のバッチ呼び出しでclampToHeightMostDetailedへ通し、
 * DEM地面との突き合わせ（非現実的な高さの除外）まで済ませた有効な結果を返す。
 */
// 2026-09-01追記: clampToHeightMostDetailedの無期限ハング対策は
// ./clampToHeightWithTimeout に共通化した（他の呼び出し箇所と揃える）。

async function clampAndValidate(
  viewer: Viewer,
  candidates: CandidatePoint[],
  label: string,
  signal?: AbortSignal
): Promise<ClampedCandidate[]> {
  const scene = viewer.scene as ClampHeightScene;
  if (candidates.length === 0 || typeof scene.clampToHeightMostDetailed !== "function") {
    return [];
  }
  const positions = candidates.map((candidate) =>
    Cartesian3.fromDegrees(candidate.longitude, candidate.latitude, VERTICAL_SEARCH_ALTITUDE_METERS)
  );
  const globe = scene.globe;
  const globeWasShown = globe?.show;
  if (globe) globe.show = false;
  let clamped: (Cartesian3 | undefined)[];
  try {
    clamped = await clampToHeightWithTimeout(
      scene,
      positions,
      // Googleタイルの形状データはこの判定に一切使わない（利用規約上の理由。
      // 高さ・位置の読み取りと保存はGoogle Maps Platformの規約で禁止されている）。
      [...viewer.entities.values, ...collectGoogleTilesetsToExclude(viewer)],
      0.12
    );
  } catch (error) {
    console.warn("PLATEAU建物の表面を取得できませんでした", error);
    return [];
  } finally {
    if (globe) globe.show = globeWasShown ?? true;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const results: ClampedCandidate[] = [];
  for (let index = 0; index < clamped.length; index += 1) {
    const surface = clamped[index];
    if (!surface) continue;
    const candidate = candidates[index];
    const cartographic = Cartographic.fromCartesian(surface);

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

    // 表面が地面（DEM）より低い、または構造物として非現実的に高い場合だけ
    // 「このタイルセットはこの地点で高さ基準が破綻している」とみなして除外する。
    // 候補自体は検索座標から最大50m以内に限定されているため、高さだけを120mで
    // 打ち切らない。これにより東京タワーや東京スカイツリー等の高塔も頂上候補に残る。
    const roofAboveGroundMeters = cartographic.height - demGroundPoint.height;
    if (
      !Number.isFinite(roofAboveGroundMeters) ||
      roofAboveGroundMeters < 0 ||
      roofAboveGroundMeters > MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS
    ) {
      continue;
    }
    results.push({ point: candidate, cartographic });
  }
  return results;
}

function highestOf(candidates: ClampedCandidate[]): ClampedCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((highest, current) =>
    current.cartographic.height > highest.cartographic.height ? current : highest
  );
}

/**
 * 標準・Googleタイルいずれのモードでも、被写体地点にPLATEAU建物（オープン
 * データ）があれば、その建物・構造物の頂上へ被写体ピンそのものを移動する
 * （高さだけでなく緯度経度も更新する）。
 *
 * Google Photorealistic 3D Tilesの表面から高さ・位置を読み取って保存する
 * ことはGoogle Maps Platformの規約で明確に禁止されている（プログラムに
 * よる測定値の読み取り・記録は二次的著作物とみなされる）ため、Googleタイル
 * モードであってもこの判定にはGoogleの形状データを一切使わず、常に
 * オープンデータであるPLATEAU建物を使う（Googleタイルモードでは表示専用の
 * 透明なPLATEAU建物を別途読み込んでから使う。判定結果はGoogleの見た目には
 * 影響しない）。
 *
 * 「周囲で最も標高が高い地点」を無条件に頂上とはみなさない。山・隣接する
 * 別の高層建築など無関係に高い構造物へ誤って移動しないよう、探索は
 * 3段階に分ける。
 *   Stage 1: 検索座標そのものをPLATEAU表面へクランプ（基準点）。
 *   Stage 2: 検索座標から半径20m以内（一般的な建物の輪郭に収まる規模）を
 *            粗く探索し、有効な候補の中で最も高い地点を頂上候補とする。
 *            この範囲に何も見つからない場合だけ、鉄塔・電波塔等の脚部が
 *            広がる構造物向けに半径30〜50mまで探索範囲を広げる
 *            （このフォールバックでは範囲が広いぶん、無関係な構造物を
 *            拾うリスクを避けるため「最初に見つかった有効な候補」を採用し、
 *            「最も高い候補」の探索はしない）。
 *   Stage 3: Stage 2で見つかった頂上候補の直近（半径6m以内）だけを、より
 *            細かい角度刻みで探り、位置・高さをさらに精密化する。
 *
 * どの段階でも有効な候補が見つからない場合はnullを返し、呼び出し側は
 * 通常のDEM地面高度にフォールバックする（高さ0m等の代替値は使わない）。
 */
export async function resolvePlateauRoofGroundPoint(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  label: string,
  signal?: AbortSignal
): Promise<ResolvedGroundPoint | null> {
  if (viewer.isDestroyed()) return null;
  const scene = viewer.scene as ClampHeightScene;
  if (typeof scene.clampToHeightMostDetailed !== "function") return null;

  // 2026-09-01追記（実機診断より）: 東京タワー等、隣接する低い建物が
  // Stage 2局所探索で先に見つかるケースでは、Stage 2局所→Stage 3精密化→
  // ジオイド取得の最大3段階が順番に実行される。各段階は個別に
  // 最大10秒（clampToHeightWithTimeout）まで待つため、直列に積み重なると
  // 合計30秒超になりうる（「検索が異常なほど遅い」という報告と一致）。
  // 呼び出し元（resolveSearchSubject）はこの関数の結果がnullでも通常の
  // DEM地面高へ安全にフォールバックするため、ここに関数全体としての
  // 上限を設けても精度上のリスクはない。
  const OVERALL_ROOF_SEARCH_TIMEOUT_MS = 15_000;
  try {
    return await withOverallTimeout(
      resolvePlateauRoofGroundPointUnbounded(viewer, latitude, longitude, label, signal),
      OVERALL_ROOF_SEARCH_TIMEOUT_MS,
      `${label}の建物屋根探索がタイムアウトしました`
    );
  } catch (error) {
    console.warn(`${label}の建物屋根探索がタイムアウトまたは失敗したため、通常のDEM地面高へフォールバックします`, error);
    return null;
  }
}

async function resolvePlateauRoofGroundPointUnbounded(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  label: string,
  signal?: AbortSignal
): Promise<ResolvedGroundPoint | null> {
  const origin: CandidatePoint = { latitude, longitude };

  // Stage 2: 局所探索（半径20m以内）。
  const localCandidates = ringCandidates(origin, LOCAL_SEARCH_OFFSETS_METERS, SAMPLING_BEARINGS_DEGREES, label);
  const localResults = await clampAndValidate(viewer, localCandidates, label, signal);
  let peak = highestOf(localResults);

  if (!peak) {
    // Stage 2で何も見つからない場合だけ、鉄塔・展望タワー・双輪アーチ状の
    // モニュメント等向けに範囲を広げる。
    //
    // 2026-08-29修正: 以前はここで「最も高い候補」ではなく「検索座標に最も
    // 近い（＝候補リストの先頭から見て最初に見つかった）有効な候補」を
    // 採用していた。しかし候補リストはoffset→bearingの順で機械的に並んで
    // いるだけで、「最初に見つかった」ことは「検索座標に最も近い」ことを
    // 意味しない。この結果、脚部が広がる鉄塔や、双輪アーチのように構造の
    // 途中（低い脚部や梁）でも表面と交差してしまう形状の場合、頂上ではなく
    // 構造物のごく低い部分（＝見た目には「タワーの下」）を被写体ピンの
    // 高さとして採用してしまっていた（例:「138タワー」検索）。
    // 探索半径はここでも最大50mまでに限定されており、無関係な高層構造物を
    // 拾うリスクはStage 2と同程度のため、Stage 2と同じく「最も高い候補」を
    // 採用するよう統一する。
    const wideCandidates = ringCandidates(origin, WIDE_FALLBACK_OFFSETS_METERS, SAMPLING_BEARINGS_DEGREES, label);
    const wideResults = await clampAndValidate(viewer, wideCandidates, label, signal);
    peak = highestOf(wideResults);
  }

  if (peak) {
    // Stage 3: 見つかった頂上候補（Stage 2 or 広域フォールバックいずれの
    // 由来でも）の直近だけを、より細かい角度刻みで精密化する。
    // 2026-08-29修正: 以前は広域フォールバックで見つかった候補（鉄塔・
    // タワー等）にはこの精密化が適用されず、粗い8方位サンプリングの精度の
    // ままだった。頂上候補の由来にかかわらず精密化を行うようにする。
    const refineCandidates = ringCandidates(peak.point, REFINE_OFFSETS_METERS, REFINE_BEARINGS_DEGREES, label);
    const refineResults = await clampAndValidate(viewer, refineCandidates, label, signal);
    const refinedPeak = highestOf(refineResults);
    if (refinedPeak && refinedPeak.cartographic.height > peak.cartographic.height) {
      peak = refinedPeak;
    }
  }

  if (!peak) return null;

  let geoidHeightMeters: number;
  try {
    geoidHeightMeters = await fetchGsiGeoidHeight(peak.cartographic);
  } catch (error) {
    console.warn(`${label}のジオイド高を取得できませんでした`, error);
    return null;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // 頂上候補の緯度経度・高さを一組として、被写体ピンそのものの座標として
  // 採用する（高さだけを検索座標へ差し戻すことはしない）。
  const point: ResolvedGroundPoint = {
    latitude: peak.point.latitude,
    longitude: peak.point.longitude,
    height: peak.cartographic.height,
    ellipsoidalHeightMeters: peak.cartographic.height,
    orthometricHeightMeters: peak.cartographic.height - geoidHeightMeters,
    geoidHeightMeters,
    heightSource: "3d-picked",
    label,
  };
  return isResolvedGroundPoint(point) ? point : null;
}

export { BASE_HEIGHT_TOLERANCE_METERS };
