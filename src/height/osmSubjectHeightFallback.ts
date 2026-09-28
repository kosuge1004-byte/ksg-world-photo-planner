import { fetchSiteContexts } from "../search/siteContext";
import type { GroundPoint } from "../types/points";
import { withVerticalOffset } from "../types/points";

/**
 * 2026-08-29追記: 被写体検索でピンが構造物の根元に立つ問題（例:
 * 東京スカイツリー、138タワー）への対策。
 *
 * resolveSearchSubject()のPLATEAU建物頂上合わせ込み（
 * resolvePlateauRoofGroundPoint）は、国交省PLATEAUの建物3Dデータに
 * 対象の構造物そのものが含まれていない場合（鉄塔・展望塔など、通常の
 * 建築物とは別区分で、全国建物データセットに収録されていないことがある）、
 * 探索半径やアルゴリズムをどれだけ改善しても原理的に頂上を見つけられない。
 * この場合はPLATEAUに頼らず、OSM（OpenStreetMap）のheight/building:levels
 * タグから構造物の高さを推定し、その分だけ検索座標の地表面から上空へ
 * 配置する。
 *
 * 既存のsite-context機能（三脚探索のsite constraints判定用に、
 * server/osmSiteContext.tsのOverpassクエリ結果をnearbyStructures /
 * nearbyBuildingsとして返す）をそのまま流用する。新しいAPI・Overpass
 * クエリは追加しない。
 *
 * 高さの厳密な実測値ではなく、OSMコミュニティによる入力・推定値である
 * ため、PLATEAU建物頂上合わせ込み（3d-picked、実表面）より優先度を
 * 下げ、PLATEAUで見つからなかった場合の追加フォールバックとしてのみ
 * 使う。
 */

// 検索座標から構造物の代表点までの許容距離。PLATEAU側の広域フォール
// バック（局所探索20m＋広域フォールバック30-50m）と同程度とし、無関係な
// 別の建物・構造物を拾わないようにする。
const MAX_MATCH_DISTANCE_METERS = 60;

export type OsmSubjectHeightHint = {
  heightMeters: number;
  source: "surveyed" | "levels-estimate";
  name: string;
};

export type OsmSubjectSurfaceInspection = {
  /** 検索名と一致する建物・塔がOSM上で確認できたか。 */
  isStructure: boolean;
  heightHint: OsmSubjectHeightHint | null;
};

function normalizedSubjectName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja")
    .replaceAll(/[\s,、・･()（）\[\]【】\-ー]/gu, "");
}

function nameMatchesSubjectLabel(candidateName: string, subjectLabel: string): boolean {
  const candidate = normalizedSubjectName(candidateName);
  const subject = normalizedSubjectName(subjectLabel);
  if (!candidate || !subject || candidate.includes("名称未登録")) return false;
  return candidate === subject || subject.startsWith(candidate) || subject.includes(candidate);
}

/**
 * 検索座標近傍の名前付き建物・構造物のうち、最も近く・高さ情報を持つ
 * ものを1件だけ返す。見つからない場合はnull（呼び出し側は通常の
 * DEM地面高のまま変更しない）。
 */
export async function findOsmSubjectHeightHint(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<OsmSubjectHeightHint | null> {
  return (await inspectOsmSubjectSurface(latitude, longitude, "", signal)).heightHint;
}

/**
 * 高さだけでなく「検索対象そのものが建物・塔か」も返す。高さタグが無い
 * 建物でも屋上必須であることを呼び出し側へ伝え、PLATEAU失敗時にDEM地表を
 * 正常値として確定しないために使う。
 */
export async function inspectOsmSubjectSurface(
  latitude: number,
  longitude: number,
  subjectLabel: string,
  signal?: AbortSignal
): Promise<OsmSubjectSurfaceInspection> {
  let contexts;
  try {
    // 2026-09-05修正: この関数はnearbyStructures/nearbyBuildingsしか
    // 使わない（walkingAccessible等のaccess系フィールドは一切見ない）ため、
    // purpose="height-only"でaccess系のOverpass問い合わせ自体を省略する。
    // 「スカイツリー」等、情報量の多い都心部で使いもしないaccess判定に
    // 時間がかかり検索全体が長時間停止して見えていた問題の実質的な対策。
    contexts = await fetchSiteContexts(
      [{ latitude, longitude }],
      signal,
      true,
      "height-only"
    );
  } catch (error) {
    console.warn("被写体の高さ推定用OSM情報を取得できませんでした", error);
    return { isStructure: false, heightHint: null };
  }
  const context = contexts[0];
  if (!context) return { isStructure: false, heightHint: null };

  const allStructures = context.nearbyStructures
    .filter((structure) => structure.distanceMeters <= MAX_MATCH_DISTANCE_METERS);
  const allBuildings = context.nearbyBuildings
    .filter((building) => building.distanceMeters <= MAX_MATCH_DISTANCE_METERS);
  const matchingStructures = subjectLabel
    ? allStructures.filter((structure) => nameMatchesSubjectLabel(structure.name, subjectLabel))
    : allStructures;
  const matchingBuildings = subjectLabel
    ? allBuildings.filter((building) => nameMatchesSubjectLabel(building.name, subjectLabel))
    : allBuildings;
  const isStructure = matchingStructures.length > 0 || matchingBuildings.length > 0;

  const selectableStructures = subjectLabel
    ? (matchingStructures.length > 0
        ? matchingStructures
        : allStructures.filter((structure) => structure.distanceMeters <= 5))
    : allStructures;
  const selectableBuildings = subjectLabel
    ? (matchingBuildings.length > 0
        ? matchingBuildings
        : allBuildings.filter((building) => building.distanceMeters <= 5))
    : allBuildings;

  const structureCandidates = selectableStructures
    .filter((structure) => structure.structureHeightMeters !== null &&
      Number.isFinite(structure.structureHeightMeters) &&
      (structure.structureHeightMeters as number) > 0 &&
      structure.distanceMeters <= MAX_MATCH_DISTANCE_METERS)
    .map((structure) => ({
      heightMeters: structure.structureHeightMeters as number,
      // 内蔵の代表構造物（precisionStructuresNear由来）はheightSourceが
      // nullになる場合があるが、既知の実測値であるためsurveyed扱いとする。
      source: (structure.heightSource ?? "surveyed") as "surveyed" | "levels-estimate",
      name: structure.name,
      distanceMeters: structure.distanceMeters,
    }));
  const buildingCandidates = selectableBuildings
    .filter((building) => building.heightMeters !== null &&
      Number.isFinite(building.heightMeters) &&
      (building.heightMeters as number) > 0 &&
      building.heightSource !== null &&
      building.distanceMeters <= MAX_MATCH_DISTANCE_METERS)
    .map((building) => ({
      heightMeters: building.heightMeters as number,
      source: building.heightSource as "surveyed" | "levels-estimate",
      name: building.name,
      distanceMeters: building.distanceMeters,
    }));

  // 2026-08-29修正: 東京タワーの脚元にはフットタウン等、別の低い建物が
  // 隣接しており、単純な「最も近い候補」だけでは、塔本体（nearbyStructures）
  // より僅かに近い低層の建物（nearbyBuildings）を誤って選んでしまうことが
  // あった。man_made=tower等の「構造物」区分は、この機能が主に対象とする
  // 塔・展望塔そのものである可能性が高いため、閾値内に構造物候補が1件でも
  // あれば、それらの中で最も近いものを優先し、建物候補は構造物候補が
  // 1件も無い場合にのみ使う。
  const best = structureCandidates.length > 0
    ? structureCandidates.sort((a, b) => a.distanceMeters - b.distanceMeters)[0]
    : buildingCandidates.sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  return {
    isStructure,
    heightHint: best
      ? { heightMeters: best.heightMeters, source: best.source, name: best.name }
      : null,
  };
}

/**
 * DEM地面高のGroundPointへ、OSM由来の推定高さを上空オフセットとして
 * 適用する。座標・緯度経度は変更せず、高さだけを積み増す。
 */
export function applyOsmSubjectHeightHint(
  groundPoint: GroundPoint,
  hint: OsmSubjectHeightHint,
  label: string
): GroundPoint {
  const withOffset = withVerticalOffset(groundPoint, hint.heightMeters, label);
  return {
    ...withOffset,
    // withVerticalOffsetは汎用の"manual"を付けるが、ユーザー手動指定では
    // ないため、由来が追跡できるよう専用の値へ差し替える。
    heightSource: hint.source === "surveyed" ? "osm-surveyed-height" : "osm-levels-estimate",
  };
}
