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

const MAX_QUERY_LENGTH = 200;

export async function resolveJapanesePlaceName(
  rawQuery: string,
  signal?: AbortSignal
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

  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Language": "ja-JP,ja;q=0.9",
        "User-Agent": "KSG-World-Photo-Planner/0.0.0",
      },
      signal,
    }
  );
  if (!response.ok) {
    throw new Error(`地名検索通信エラー：${response.status}`);
  }
  const places = await response.json() as NominatimPlace[];
  const place = places.find((candidate) =>
    Number.isFinite(Number(candidate.lat)) &&
    Number.isFinite(Number(candidate.lon)) &&
    typeof candidate.display_name === "string"
  );
  if (!place) throw new Error("指定したスポットが見つかりませんでした");

  return {
    latitude: Number(place.lat),
    longitude: Number(place.lon),
    label: String(place.display_name),
  };
}
