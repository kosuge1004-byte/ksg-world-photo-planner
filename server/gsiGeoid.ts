type GsiGeoidResponse = {
  OutputData?: {
    geoidHeight?: unknown;
  };
};

const cache = new Map<string, Promise<number>>();
const MAX_CACHE_ENTRIES = 128;

function validatedCoordinate(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 20 ||
    latitude > 46.5 ||
    longitude < 122 ||
    longitude > 154
  ) {
    throw new Error("ジオイド高の取得範囲外です");
  }
}

export async function lookupGsiGeoidHeight(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<number> {
  validatedCoordinate(latitude, longitude);
  // ジオイドは滑らかなため0.01度単位で共有し、公式APIの回数制限内で利用する。
  const queryLatitude = Number(latitude.toFixed(2));
  const queryLongitude = Number(longitude.toFixed(2));
  const key = `${queryLatitude},${queryLongitude}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const request = fetch(
    "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?" +
      new URLSearchParams({
        outputType: "json",
        latitude: String(queryLatitude),
        longitude: String(queryLongitude),
      }),
    { headers: { Accept: "application/json" }, signal }
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(`国土地理院ジオイドAPIエラー：${response.status}`);
    }
    const data = await response.json() as GsiGeoidResponse;
    const height = Number(data.OutputData?.geoidHeight);
    if (!Number.isFinite(height)) {
      throw new Error("国土地理院ジオイドAPIの応答が不正です");
    }
    return height;
  }).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, request);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") cache.delete(oldest);
  }
  return request;
}
