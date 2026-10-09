import {
  cleanPlaceQuery,
  normalizedPlaceText,
  placeQueryVariants,
} from "./placeTextNormalization.ts";

export type ResolvedPlaceName = {
  latitude: number;
  longitude: number;
  label: string;
  subjectSurfaceTarget?: "terrain" | "structure-roof";
  structureHeightMeters?: number;
  category?: string;
  heightSourceType?: "osm-height" | "osm-levels-estimate" | "unknown";
  heightSourceUrl?: string | null;
  heightSourceLabel?: string | null;
  heightStatus?: "estimated" | "unknown";
};

/** スポット検索の候補一覧に出す1件。ResolvedPlaceNameとしてそのままピン配置に使える。 */
export type PlaceCandidate = ResolvedPlaceName & {
  /** 候補の主名称（施設名・地名）。 */
  name: string;
  /** 所在地の補足（都道府県・市区町村など）。不明なら空文字。 */
  detail: string;
  /** 種別の表示名（山・駅・塔 など）。不明ならnull。 */
  kind: string | null;
  source: "nominatim" | "gsi" | "photon";
  /** 検索時に指定した地図中心からの距離（km）。中心未指定なら省略。 */
  distanceKm?: number;
};

export type PlaceSearchCenter = { latitude: number; longitude: number };

export type PlaceCandidateSearchOptions = {
  /**
   * suggest: 入力途中の候補表示。入力補完に対応したPhotonだけを使う
   *          （Nominatimは利用規約で入力補完用途が禁止されているため使わない）。
   * search : 検索確定時。Nominatim・国土地理院・Photonを統合する。
   */
  mode?: "suggest" | "search";
  /** 表示中の地図中心。近い候補を上位にする。 */
  center?: PlaceSearchCenter | null;
  limit?: number;
};

type NominatimPlace = {
  osm_type?: unknown;
  osm_id?: unknown;
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  name?: unknown;
  namedetails?: unknown;
  category?: unknown;
  type?: unknown;
  importance?: unknown;
  extratags?: unknown;
};

type GsiAddressFeature = {
  geometry?: {
    type?: unknown;
    coordinates?: unknown;
  };
  properties?: {
    title?: unknown;
  };
};

type Fetcher = typeof fetch;

type PhotonFeature = {
  geometry?: {
    type?: unknown;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

type RankedPlace = {
  resolved: ResolvedPlaceName;
  score: number;
  source: "nominatim" | "gsi" | "photon";
  index: number;
  /** 候補一覧用の表示情報。 */
  name: string;
  detail: string;
  kind: string | null;
};

// 日本周辺（南西諸島〜北海道、小笠原を含む）。Photonの検索範囲を絞る。
const JAPAN_BBOX = "122.5,20.0,154.5,46.0";
const DEFAULT_CANDIDATE_LIMIT = 8;
const MAX_CANDIDATE_LIMIT = 12;

const MAX_QUERY_LENGTH = 200;
// どちらか一方の検索サービスが遅くても全体を長時間止めない。
// 並列実行なので通常は最も遅い側の上限までで判定が完了する。
const PROVIDER_TIMEOUT_MS = 4_000;

export async function resolveJapanesePlaceName(
  rawQuery: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<ResolvedPlaceName> {
  const query = rawQuery.trim();
  if (!query) throw new Error("スポット名を入力してください");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`スポット名は${MAX_QUERY_LENGTH}文字以内で入力してください`);
  }

  const coordinateMatch = query.match(
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,、]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
  );
  if (coordinateMatch) {
    const latitude = Number(coordinateMatch[1]);
    const longitude = Number(coordinateMatch[2]);
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    ) {
      return { latitude, longitude, label: `${latitude}, ${longitude}` };
    }
  }

  // 精度優先: 先に返ったプロバイダーだけで確定しない。
  // Nominatim と国土地理院の両結果を待ち、名称・POI情報を同じ基準で比較する。
  // 通信速度によって同じ検索語の座標が変わる非決定性を排除する。
  //
  // 2026-10-08: 入力そのままで1件も見つからない場合だけ、表記ゆれの言い換え
  // （旧字体・「ヶ/ケ/が」・空白など）を順に試す。通常の検索では追加通信しない。
  const variants = placeQueryVariants(query);
  let nominatimOutcome!: PromiseSettledResult<RankedPlace[]>;
  let gsiOutcome!: PromiseSettledResult<RankedPlace[]>;
  const candidates: RankedPlace[] = [];
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
    const variant = variantIndex === 0 ? query : variants[variantIndex];
    const [nominatimAttempt, gsiAttempt] = await Promise.all([
      settleProvider(searchNominatim(variant, signal, fetcher)),
      settleProvider(searchGsi(variant, signal, fetcher)),
    ]);
    if (signal?.aborted) throw abortFromSignal(signal);
    if (variantIndex === 0) {
      nominatimOutcome = nominatimAttempt;
      gsiOutcome = gsiAttempt;
    }
    if (nominatimAttempt.status === "fulfilled") candidates.push(...nominatimAttempt.value);
    if (gsiAttempt.status === "fulfilled") candidates.push(...gsiAttempt.value);
    if (candidates.length > 0) break;
    // 両方とも通信失敗なら、言い換えても同じ結果になるので打ち切る。
    if (nominatimAttempt.status === "rejected" && gsiAttempt.status === "rejected") break;
  }

  candidates.sort(compareRankedPlaces);
  if (candidates[0]) {
    const best = candidates[0].resolved;
    if (best.subjectSurfaceTarget === "structure-roof") return best;
    // GSI住所検索が名称一致で1位になっても、ほぼ同じ座標のNominatim
    // 建物分類・高さタグは捨てない。座標は従来どおり1位候補を維持する。
    const structureMetadata = candidates.find((candidate) =>
      candidate.resolved.subjectSurfaceTarget === "structure-roof" &&
      Math.abs(candidate.resolved.latitude - best.latitude) <= 0.001 &&
      Math.abs(candidate.resolved.longitude - best.longitude) <= 0.001
    )?.resolved;
    return structureMetadata
      ? {
          ...best,
          subjectSurfaceTarget: "structure-roof",
          structureHeightMeters: structureMetadata.structureHeightMeters,
          category: structureMetadata.category,
          heightSourceType: structureMetadata.heightSourceType,
          heightSourceUrl: structureMetadata.heightSourceUrl,
          heightSourceLabel: structureMetadata.heightSourceLabel,
          heightStatus: structureMetadata.heightStatus,
        }
      : best;
  }

  // 一方が落ちても他方が「検索結果なし」まで正常完了していれば、通信障害を
  // ユーザーへ誤って最終原因として見せない。両方が通信失敗した場合だけ通信
  // エラーを返す。
  if (
    nominatimOutcome.status === "rejected" &&
    gsiOutcome.status === "rejected"
  ) {
    throw bestProviderError(nominatimOutcome.reason, gsiOutcome.reason);
  }
  throw new Error("指定したスポットが見つかりませんでした");
}

function settleProvider<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value } as PromiseFulfilledResult<T>),
    (reason) => ({ status: "rejected", reason } as PromiseRejectedResult)
  );
}

function abortFromSignal(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("検索中止", "AbortError");
}

async function searchNominatim(
  query: string,
  parentSignal: AbortSignal | undefined,
  fetcher: Fetcher,
  options: { limit?: number; center?: PlaceSearchCenter | null } = {}
): Promise<RankedPlace[]> {
  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(options.limit ?? 5),
    addressdetails: "1",
    namedetails: "1",
    extratags: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  if (options.center) {
    // bounded=0（既定）なので範囲外も返る。地図中心付近を優先させるだけ。
    const { latitude, longitude } = options.center;
    parameters.set(
      "viewbox",
      `${longitude - 1},${latitude + 1},${longitude + 1},${latitude - 1}`
    );
  }
  const response = await fetcher(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    {
      headers: nominatimRequestHeaders(),
      signal: providerSignal(parentSignal),
    }
  );
  if (!response.ok) {
    throw new Error(`Nominatim地名検索通信エラー：${response.status}`);
  }
  const places = await response.json() as NominatimPlace[];
  if (!Array.isArray(places)) return [];
  return places.flatMap((place, index) => {
    if (!validNominatimPlace(place)) return [];
    const resolved: ResolvedPlaceName = {
      latitude: Number(place.lat),
      longitude: Number(place.lon),
      label: String(place.display_name),
      ...nominatimSubjectSurfaceMetadata(place),
    };
    const importance = Number(place.importance);
    // display_name は住所まで含むため、施設名が完全一致していても
    // startsWith 扱いになってしまう。name / namedetails の正式名称を優先し、
    // 「岐阜城」のようなPOIを住所検索の短いラベルより下にしない。
    const primaryName = nominatimPrimaryName(place);
    const textScore = Math.min(
      primaryName ? placeTextScore(query, primaryName) : Number.POSITIVE_INFINITY,
      placeTextScore(query, resolved.label)
    );
    const importancePenalty = Number.isFinite(importance)
      ? Math.max(0, Math.min(0.9, 1 - importance))
      : 0.9;
    // 正式施設名が検索語と完全一致するPOIは、GSI住所検索の短い同名ラベルより
    // 優先する。これにより「岐阜城」のような施設検索で住所側の同名地点に
    // 引っ張られない。部分一致ではこのボーナスを与えない。
    const exactPrimaryNameBonus = primaryName &&
      normalizedPlaceText(primaryName) === normalizedPlaceText(query) ? -2 : 0;
    const poiBonus = isNominatimPoi(place) ? -0.5 : 0;
    const category = typeof place.category === "string" ? place.category : "";
    const type = typeof place.type === "string" ? place.type : "";
    return [{
      resolved,
      index,
      source: "nominatim" as const,
      score: textScore + importancePenalty + exactPrimaryNameBonus + poiBonus,
      name: primaryName ?? resolved.label.split(/[,、]/u)[0]?.trim() ?? resolved.label,
      detail: nominatimAddressDetail(resolved.label),
      kind: osmKindLabel(category, type),
    }];
  });
}

async function searchGsi(
  query: string,
  parentSignal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<RankedPlace[]> {
  const parameters = new URLSearchParams({ q: query });
  const response = await fetcher(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?${parameters}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Language": "ja-JP,ja;q=0.9",
      },
      signal: providerSignal(parentSignal),
    }
  );
  if (!response.ok) {
    throw new Error(`国土地理院地名検索通信エラー：${response.status}`);
  }
  const features = await response.json() as GsiAddressFeature[];
  if (!Array.isArray(features)) return [];
  return features.flatMap((feature, index) => {
    const resolved = resolvedGsiPlace(feature);
    return resolved
      ? [{
          resolved,
          index,
          source: "gsi" as const,
          score: placeTextScore(query, resolved.label),
          name: resolved.label,
          detail: "",
          kind: "住所・地名",
        }]
      : [];
  });
}

/**
 * 2026-10-09修正: この検索は、サーバー（Pages Functions）からも端末のブラウザからも
 * 実行される（候補一覧の取得でサーバーが使えないときの予備経路）。
 * ブラウザから User-Agent を指定すると、SafariやFirefoxでは「事前確認が必要な
 * リクエスト」になり、Nominatim側がそのヘッダーを許可していないため通信ごと拒否
 * される。ブラウザは自身の User-Agent と参照元を自動で送るので、指定はサーバー
 * 実行時だけにする（Nominatimの利用方針が求めるアプリの識別）。
 */
export function nominatimRequestHeaders(
  runsInBrowser = typeof (globalThis as { document?: unknown }).document !== "undefined"
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "ja-JP,ja;q=0.9",
  };
  if (!runsInBrowser) headers["User-Agent"] = "AstroSight/1.0";
  return headers;
}

function nominatimPrimaryName(place: NominatimPlace): string | null {
  if (typeof place.name === "string" && place.name.trim()) return place.name.trim();
  if (!place.namedetails || typeof place.namedetails !== "object") return null;
  const details = place.namedetails as Record<string, unknown>;
  for (const key of ["name:ja", "name", "official_name:ja", "official_name", "short_name:ja", "short_name"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isNominatimPoi(place: NominatimPlace): boolean {
  const category = typeof place.category === "string" ? place.category : "";
  const type = typeof place.type === "string" ? place.type : "";
  return ["tourism", "historic", "amenity", "man_made", "leisure"].includes(category) ||
    ["castle", "attraction", "museum", "monument", "memorial", "viewpoint"].includes(type);
}

function nominatimSubjectSurfaceMetadata(
  place: NominatimPlace
): OsmSubjectSurfaceMetadata {
  return osmSubjectSurfaceMetadata(
    typeof place.category === "string" ? place.category : "",
    typeof place.type === "string" ? place.type : "",
    place.extratags
  );
}

type OsmSubjectSurfaceMetadata = Pick<ResolvedPlaceName, "subjectSurfaceTarget" |
  "structureHeightMeters" | "category" | "heightSourceType" | "heightSourceUrl" |
  "heightSourceLabel" | "heightStatus">;

/** OSMのキー/値（Nominatimのcategory/type、Photonのosm_key/osm_value）から被写体種別を決める。 */
function osmSubjectSurfaceMetadata(
  category: string,
  type: string,
  extratags: unknown
): OsmSubjectSurfaceMetadata {
  const isStructure = category === "building" ||
    (category === "man_made" && [
      "tower", "communications_tower", "mast", "lighthouse", "chimney", "water_tower", "obelisk",
    ].includes(type)) ||
    (category === "historic" && ["castle", "fort", "monument"].includes(type)) ||
    (category === "amenity" && type === "place_of_worship") ||
    (category === "tourism" && ["hotel", "museum"].includes(type)) ||
    (category === "leisure" && type === "stadium");
  const resolvedCategory = [category, type].filter(Boolean).join("/") || "unknown";
  if (!isStructure) return { category: resolvedCategory };
  const tags = extratags && typeof extratags === "object"
    ? extratags as Record<string, unknown>
    : {};
  const mappedHeight = Number.parseFloat(String(tags.height ?? ""));
  const levels = Number.parseFloat(String(tags["building:levels"] ?? ""));
  const structureHeightMeters = Number.isFinite(mappedHeight) && mappedHeight > 0
    ? mappedHeight
    : Number.isFinite(levels) && levels > 0
      ? levels * 3
      : undefined;
  return {
    subjectSurfaceTarget: "structure-roof",
    structureHeightMeters,
    category: resolvedCategory,
    heightSourceType: Number.isFinite(mappedHeight) && mappedHeight > 0
      ? "osm-height"
      : Number.isFinite(levels) && levels > 0
        ? "osm-levels-estimate"
        : "unknown",
    heightSourceUrl: "https://www.openstreetmap.org/",
    heightSourceLabel: Number.isFinite(mappedHeight) && mappedHeight > 0
      ? "OpenStreetMap height"
      : Number.isFinite(levels) && levels > 0
        ? "OpenStreetMap building:levels × 3m"
        : null,
    heightStatus: structureHeightMeters === undefined ? "unknown" : "estimated",
  };
}

function providerSignal(parentSignal?: AbortSignal): AbortSignal {
  // 2026-10-08: 入力補完は端末のブラウザからも直接実行する。AbortSignal.timeout /
  // AbortSignal.any が無い古いWebViewでも検索自体は動くよう、手動で合成する。
  const signalApi = AbortSignal as typeof AbortSignal & {
    timeout?: (milliseconds: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof signalApi.timeout === "function" &&
    (!parentSignal || typeof signalApi.any === "function")) {
    const timeoutSignal = signalApi.timeout(PROVIDER_TIMEOUT_MS);
    return parentSignal ? signalApi.any!([parentSignal, timeoutSignal]) : timeoutSignal;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("地名検索がタイムアウトしました");
    error.name = "TimeoutError";
    controller.abort(error);
  }, PROVIDER_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  }
  return controller.signal;
}

function bestProviderError(left: unknown, right: unknown): Error {
  const errors = [left, right].filter((value): value is Error => value instanceof Error);
  const nonTimeout = errors.find((error) => error.name !== "TimeoutError");
  if (nonTimeout) return nonTimeout;
  if (errors[0]) return errors[0];
  return new Error("地名検索サービスへ接続できませんでした");
}

function compareRankedPlaces(left: RankedPlace, right: RankedPlace): number {
  return left.score - right.score ||
    left.resolved.label.length - right.resolved.label.length ||
    // 同点時は施設・POIを広く持つNominatimを僅かに優先する。
    (left.source === right.source ? 0 : left.source === "nominatim" ? -1
      : right.source === "nominatim" ? 1 : 0) ||
    left.index - right.index;
}

function validNominatimPlace(place: NominatimPlace): boolean {
  const latitude = Number(place.lat);
  const longitude = Number(place.lon);
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof place.display_name === "string" &&
    place.display_name.length > 0;
}

function resolvedGsiPlace(feature: GsiAddressFeature): ResolvedPlaceName | null {
  if (
    feature.geometry?.type !== "Point" ||
    !Array.isArray(feature.geometry.coordinates) ||
    typeof feature.properties?.title !== "string" ||
    feature.properties.title.length === 0
  ) {
    return null;
  }
  const longitude = Number(feature.geometry.coordinates[0]);
  const latitude = Number(feature.geometry.coordinates[1]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude, label: feature.properties.title };
}

function placeTextScore(query: string, title: string): number {
  const normalizedQuery = normalizedPlaceText(query);
  const normalizedTitle = normalizedPlaceText(title);
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 10;
  if (normalizedTitle.includes(normalizedQuery)) return 20;
  if (normalizedQuery.includes(normalizedTitle)) return 30;
  return 50;
}

// ---------------------------------------------------------------------------
// 2026-10-08: 候補一覧（入力補完・複数候補からの選択）
// ---------------------------------------------------------------------------

/**
 * 検索語に対する候補を、関連度と地図中心からの近さで並べて返す。
 * 1件に確定せず、同名の場所や曖昧な検索語を利用者が選べるようにする。
 * 候補が無い場合は空配列（通信が全滅した場合のみ例外）。
 */
export async function searchJapanesePlaceCandidates(
  rawQuery: string,
  options: PlaceCandidateSearchOptions = {},
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<PlaceCandidate[]> {
  const query = cleanPlaceQuery(rawQuery);
  if (!query) throw new Error("スポット名を入力してください");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`スポット名は${MAX_QUERY_LENGTH}文字以内で入力してください`);
  }
  const mode = options.mode ?? "search";
  const center = validCenter(options.center);
  const limit = Math.max(1, Math.min(MAX_CANDIDATE_LIMIT,
    Math.trunc(options.limit ?? DEFAULT_CANDIDATE_LIMIT)));

  // 入力補完は1打鍵ごとに走るため、言い換えは1回までに抑える。
  const variants = placeQueryVariants(query, mode === "suggest" ? 2 : 4);
  const ranked: RankedPlace[] = [];
  let firstFailure: unknown = null;
  let anyProviderSucceeded = false;

  for (const variant of variants) {
    const outcomes = mode === "suggest"
      ? await suggestOutcomes(variant, center, signal, fetcher)
      : await Promise.all([
          settleProvider(searchNominatim(variant, signal, fetcher, { limit: 10, center })),
          settleProvider(searchGsi(variant, signal, fetcher)),
          settleProvider(searchPhoton(variant, signal, fetcher, { limit: 8, center })),
        ]);
    if (signal?.aborted) throw abortFromSignal(signal);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        anyProviderSucceeded = true;
        // 国土地理院は部分一致を大量に返すことがあるため、上位だけを統合対象にする。
        const places = outcome.value[0]?.source === "gsi"
          ? [...outcome.value].sort(compareRankedPlaces).slice(0, 5)
          : outcome.value;
        // 順位付けは利用者が入力した検索語を基準にそろえる。
        ranked.push(...places.map((place) => variant === query ? place : {
          ...place,
          score: place.score - placeTextScore(variant, place.name) + placeTextScore(query, place.name),
        }));
      } else if (firstFailure === null) {
        firstFailure = outcome.reason;
      }
    }
    if (ranked.length > 0) break;
    if (!anyProviderSucceeded) break;
  }

  if (ranked.length === 0) {
    if (!anyProviderSucceeded) {
      throw firstFailure instanceof Error
        ? firstFailure
        : new Error("地名検索サービスへ接続できませんでした");
    }
    return [];
  }

  const scored = ranked.map((place) => {
    const distanceKm = center
      ? distanceKilometers(center, place.resolved)
      : undefined;
    return {
      place,
      distanceKm,
      score: place.score + (distanceKm === undefined ? 0 : distancePenalty(distanceKm)),
    };
  }).sort((left, right) =>
    left.score - right.score || compareRankedPlaces(left.place, right.place)
  );

  const kept: Array<{ candidate: PlaceCandidate; key: string }> = [];
  for (const { place, distanceKm } of scored) {
    const key = normalizedPlaceText(place.name);
    const duplicate = kept.find((item) => {
      const separationKm = distanceKilometers(item.candidate, place.resolved);
      if (separationKm <= 0.04) return true;
      return separationKm <= 0.4 && Boolean(key) && Boolean(item.key) &&
        (item.key === key || item.key.includes(key) || key.includes(item.key));
    });
    if (duplicate) {
      // 上位候補が住所検索やPhoton由来でも、同じ場所のNominatim結果が持つ
      // 建物分類・高さタグは捨てない（resolveJapanesePlaceNameと同じ方針）。
      const target = duplicate.candidate;
      if (target.subjectSurfaceTarget !== "structure-roof" &&
        place.resolved.subjectSurfaceTarget === "structure-roof" &&
        distanceKilometers(target, place.resolved) <= 0.11) {
        Object.assign(target, structureFields(place.resolved));
      } else if (target.subjectSurfaceTarget === "structure-roof" &&
        target.structureHeightMeters === undefined &&
        place.resolved.subjectSurfaceTarget === "structure-roof" &&
        place.resolved.structureHeightMeters !== undefined &&
        distanceKilometers(target, place.resolved) <= 0.11) {
        Object.assign(target, structureFields(place.resolved));
      }
      if (!target.detail && place.detail) target.detail = place.detail;
      if ((!target.kind || target.kind === "住所・地名") && place.kind && place.kind !== "住所・地名" &&
        duplicate.key === key) {
        target.kind = place.kind;
      }
      continue;
    }
    if (kept.length >= limit) continue;
    kept.push({
      key,
      candidate: {
        ...place.resolved,
        name: place.name,
        detail: place.detail,
        kind: place.kind,
        source: place.source,
        ...(distanceKm === undefined ? {} : { distanceKm: Math.round(distanceKm * 10) / 10 }),
      },
    });
  }
  return kept.map((item) => item.candidate);
}

async function suggestOutcomes(
  query: string,
  center: PlaceSearchCenter | null,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<Array<PromiseSettledResult<RankedPlace[]>>> {
  const photon = await settleProvider(searchPhoton(query, signal, fetcher, { limit: 8, center }));
  if (photon.status === "fulfilled" && photon.value.length > 0) return [photon];
  if (signal?.aborted) return [photon];
  // Photonが停止中・0件のときだけ国土地理院（住所・地名）で補う。
  return [photon, await settleProvider(searchGsi(query, signal, fetcher))];
}

async function searchPhoton(
  query: string,
  parentSignal: AbortSignal | undefined,
  fetcher: Fetcher,
  options: { limit: number; center: PlaceSearchCenter | null }
): Promise<RankedPlace[]> {
  // langは指定しない（公開Photonは ja を受け付けず、既定で現地語名を返す）。
  const parameters = new URLSearchParams({
    q: query,
    limit: String(options.limit),
    bbox: JAPAN_BBOX,
  });
  if (options.center) {
    parameters.set("lat", options.center.latitude.toFixed(4));
    parameters.set("lon", options.center.longitude.toFixed(4));
    parameters.set("zoom", "10");
    parameters.set("location_bias_scale", "0.3");
  }
  const response = await fetcher(`https://photon.komoot.io/api/?${parameters}`, {
    headers: { Accept: "application/json" },
    signal: providerSignal(parentSignal),
  });
  if (!response.ok) {
    throw new Error(`Photon地名検索通信エラー：${response.status}`);
  }
  const body = await response.json() as { features?: unknown };
  if (!Array.isArray(body?.features)) return [];
  return (body.features as PhotonFeature[]).flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const text = (key: string): string => {
      const value = properties[key];
      return typeof value === "string" ? value.trim() : "";
    };
    if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return [];
    const longitude = Number(feature.geometry.coordinates[0]);
    const latitude = Number(feature.geometry.coordinates[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    const countryCode = text("countrycode").toUpperCase();
    if (countryCode && countryCode !== "JP") return [];
    const name = text("name") || [text("street"), text("housenumber")].filter(Boolean).join(" ");
    if (!name) return [];
    const osmKey = text("osm_key");
    const osmValue = text("osm_value");
    const region = uniqueTexts([text("state"), text("county"), text("city"), text("district")])
      .filter((part) => part !== name);
    const resolved: ResolvedPlaceName = {
      latitude,
      longitude,
      // Nominatimのdisplay_nameと同じ「名称, 狭い地域, 広い地域」の並びにそろえる。
      label: [name, ...[...region].reverse()].join(", "),
      ...osmSubjectSurfaceMetadata(osmKey, osmValue, undefined),
    };
    const isPoi = ["tourism", "historic", "amenity", "man_made", "leisure", "natural", "railway"]
      .includes(osmKey);
    return [{
      resolved,
      index,
      source: "photon" as const,
      // Photonは重要度を返さないので、返却順（関連度順）を小さな差として使う。
      score: placeTextScore(query, name) + 0.6 + index * 0.03 + (isPoi ? -0.5 : 0),
      name,
      detail: region.join(" "),
      kind: osmKindLabel(osmKey, osmValue),
    }];
  });
}

function uniqueTexts(values: string[]): string[] {
  return values.filter((value, index) => Boolean(value) && values.indexOf(value) === index);
}

function structureFields(place: ResolvedPlaceName): OsmSubjectSurfaceMetadata {
  return {
    subjectSurfaceTarget: place.subjectSurfaceTarget,
    structureHeightMeters: place.structureHeightMeters,
    category: place.category,
    heightSourceType: place.heightSourceType,
    heightSourceUrl: place.heightSourceUrl,
    heightSourceLabel: place.heightSourceLabel,
    heightStatus: place.heightStatus,
  };
}

/** 「東京タワー, 芝公園四丁目, 港区, 東京都, 105-0011, 日本」→「東京都 港区 芝公園四丁目」 */
function nominatimAddressDetail(displayName: string): string {
  const parts = displayName.split(/,\s*/u).slice(1)
    .map((part) => part.trim())
    .filter((part) => part && part !== "日本" && !/^\d{3}-?\d{4}$/u.test(part));
  return parts.reverse().slice(0, 3).join(" ");
}

function osmKindLabel(key: string, value: string): string | null {
  const exact: Record<string, string> = {
    "natural/peak": "山", "natural/volcano": "山", "natural/ridge": "尾根", "natural/saddle": "峠",
    "natural/cape": "岬", "natural/beach": "海岸", "natural/water": "湖・池", "natural/bay": "湾",
    "natural/cliff": "崖", "natural/wetland": "湿原", "natural/wood": "森林",
    "waterway/waterfall": "滝", "waterway/river": "川", "waterway/dam": "ダム",
    "railway/station": "駅", "railway/halt": "駅", "railway/tram_stop": "停留場",
    "public_transport/station": "駅", "aeroway/aerodrome": "空港",
    "man_made/tower": "塔", "man_made/communications_tower": "塔", "man_made/mast": "鉄塔",
    "man_made/lighthouse": "灯台", "man_made/bridge": "橋", "man_made/chimney": "煙突",
    "man_made/observatory": "天文台", "man_made/pier": "桟橋", "man_made/torii": "鳥居",
    "historic/castle": "城", "historic/monument": "記念碑", "historic/memorial": "記念碑",
    "historic/ruins": "史跡", "historic/archaeological_site": "史跡",
    "amenity/place_of_worship": "寺社", "amenity/parking": "駐車場",
    "tourism/viewpoint": "展望地", "tourism/attraction": "観光名所", "tourism/museum": "博物館",
    "tourism/hotel": "宿泊施設", "tourism/camp_site": "キャンプ場", "tourism/alpine_hut": "山小屋",
    "tourism/theme_park": "テーマパーク", "tourism/zoo": "動物園", "tourism/aquarium": "水族館",
    "leisure/park": "公園", "leisure/stadium": "スタジアム", "leisure/garden": "庭園",
    "leisure/nature_reserve": "自然保護区", "boundary/national_park": "国立公園",
    "boundary/administrative": "行政区域", "place/island": "島", "place/islet": "島",
  };
  const label = exact[`${key}/${value}`];
  if (label) return label;
  const byKey: Record<string, string> = {
    building: "建物", highway: "道路", place: "地名", shop: "店舗", amenity: "施設",
    tourism: "観光", historic: "史跡", leisure: "レジャー", natural: "自然", railway: "鉄道",
    bridge: "橋", office: "事業所", waterway: "水路", man_made: "構造物", aeroway: "航空",
  };
  return byKey[key] ?? null;
}

function validCenter(center: PlaceSearchCenter | null | undefined): PlaceSearchCenter | null {
  if (!center) return null;
  const latitude = Number(center.latitude);
  const longitude = Number(center.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

function distanceKilometers(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const toRadians = Math.PI / 180;
  const lat1 = a.latitude * toRadians;
  const lat2 = b.latitude * toRadians;
  const dLat = lat2 - lat1;
  const dLon = (b.longitude - a.longitude) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 地図中心からの距離による減点。10km以内は0、100kmで0.75、1000km以上で1.5。
 * 名称の一致度（10点刻み）は覆さず、同程度に一致する候補の中で近い方を上にする。
 */
function distancePenalty(distanceKm: number): number {
  if (!(distanceKm > 10)) return 0;
  return Math.min(1.5, Math.log10(distanceKm / 10) * 0.75);
}
