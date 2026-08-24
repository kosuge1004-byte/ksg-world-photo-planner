export type ResolvedPlaceName = {
  latitude: number;
  longitude: number;
  label: string;
};

type NominatimPlace = {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  name?: unknown;
  namedetails?: unknown;
  category?: unknown;
  type?: unknown;
  importance?: unknown;
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

type RankedPlace = {
  resolved: ResolvedPlaceName;
  score: number;
  source: "nominatim" | "gsi";
  index: number;
};

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
  const nominatimPromise = settleProvider(searchNominatim(query, signal, fetcher));
  const gsiPromise = settleProvider(searchGsi(query, signal, fetcher));
  const [nominatimOutcome, gsiOutcome] = await Promise.all([nominatimPromise, gsiPromise]);

  if (signal?.aborted) throw abortFromSignal(signal);

  const candidates: RankedPlace[] = [];
  if (nominatimOutcome.status === "fulfilled") candidates.push(...nominatimOutcome.value);
  if (gsiOutcome.status === "fulfilled") candidates.push(...gsiOutcome.value);

  candidates.sort(compareRankedPlaces);
  if (candidates[0]) return candidates[0].resolved;

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
  fetcher: Fetcher
): Promise<RankedPlace[]> {
  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const response = await fetcher(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Language": "ja-JP,ja;q=0.9",
        "User-Agent": "AstroSight/1.0",
      },
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
    return [{
      resolved,
      index,
      source: "nominatim" as const,
      score: textScore + importancePenalty + exactPrimaryNameBonus + poiBonus,
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
        }]
      : [];
  });
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

function providerSignal(parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
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
    (left.source === right.source ? 0 : left.source === "nominatim" ? -1 : 1) ||
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

function normalizedPlaceText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja").replaceAll(/[\s,、・･\-ー]/gu, "");
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
