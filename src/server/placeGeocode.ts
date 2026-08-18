export type ResolvedPlaceName = {
  latitude: number;
  longitude: number;
  label: string;
};

type NominatimPlace = {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
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

const MAX_QUERY_LENGTH = 200;

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

  const nominatimParameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  let nominatimError: unknown;
  try {
    const response = await fetcher(
      `https://nominatim.openstreetmap.org/search?${nominatimParameters}`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Language": "ja-JP,ja;q=0.9",
          "User-Agent": "AstroSight/0.0.0",
        },
        signal,
      }
    );
    if (!response.ok) {
      throw new Error(`地名検索通信エラー：${response.status}`);
    }
    const places = await response.json() as NominatimPlace[];
    const place = Array.isArray(places)
      ? places.find((candidate) => validNominatimPlace(candidate))
      : undefined;
    if (place) {
      return {
        latitude: Number(place.lat),
        longitude: Number(place.lon),
        label: String(place.display_name),
      };
    }
  } catch (error) {
    nominatimError = error;
  }

  const gsiParameters = new URLSearchParams({ q: query });
  try {
    const response = await fetcher(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?${gsiParameters}`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Language": "ja-JP,ja;q=0.9",
        },
        signal,
      }
    );
    if (!response.ok) {
      throw new Error(`地名検索通信エラー：${response.status}`);
    }
    const features = await response.json() as GsiAddressFeature[];
    const candidates = Array.isArray(features)
      ? features.flatMap((feature, index) => {
          const resolved = resolvedGsiPlace(feature);
          return resolved
            ? [{ resolved, index, score: gsiTitleScore(query, resolved.label) }]
            : [];
        })
      : [];
    candidates.sort((left, right) =>
      left.score - right.score ||
      left.resolved.label.length - right.resolved.label.length ||
      left.index - right.index
    );
    if (candidates[0]) return candidates[0].resolved;
  } catch (error) {
    if (nominatimError) throw nominatimError;
    throw error;
  }

  if (nominatimError) throw nominatimError;
  throw new Error("指定したスポットが見つかりませんでした");
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
  return value.normalize("NFKC").toLocaleLowerCase("ja").replaceAll(/\s+/gu, "");
}

function gsiTitleScore(query: string, title: string): number {
  const normalizedQuery = normalizedPlaceText(query);
  const normalizedTitle = normalizedPlaceText(title);
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 2;
  if (normalizedQuery.includes(normalizedTitle)) return 3;
  return 4;
}
