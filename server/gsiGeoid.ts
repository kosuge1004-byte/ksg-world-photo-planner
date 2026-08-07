import { LruPromiseCache } from "./lruPromiseCache.ts";

type GsiGeoidResponse = {
  OutputData?: {
    geoidHeight?: unknown;
  };
};

const cache = new LruPromiseCache<number>({
  maxEntries: 128,
  ttlMs: 24 * 60 * 60 * 1000,
});

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGeoidHeightOnce(
  queryLatitude: number,
  queryLongitude: number,
  signal?: AbortSignal
): Promise<number> {
  const response = await fetch(
    "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?" +
      new URLSearchParams({
        outputType: "json",
        latitude: String(queryLatitude),
        longitude: String(queryLongitude),
      }),
    { headers: { Accept: "application/json" }, signal }
  );
  if (!response.ok) {
    throw new Error(`国土地理院ジオイドAPIエラー：${response.status}`);
  }
  const data = await response.json() as GsiGeoidResponse;
  const height = Number(data.OutputData?.geoidHeight);
  if (!Number.isFinite(height)) {
    throw new Error("国土地理院ジオイドAPIの応答が不正です");
  }
  return height;
}

// 国土地理院の測量計算ツール（本番API向けではないレガシーCGI）は
// 一時的な失敗が珍しくないため、あきらめる前に短い間隔で数回だけ再試行する。
const GEOID_FETCH_MAX_ATTEMPTS = 3;
const GEOID_FETCH_RETRY_DELAY_MS = 400;

async function fetchGeoidHeightWithRetry(
  queryLatitude: number,
  queryLongitude: number,
  signal?: AbortSignal
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GEOID_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchGeoidHeightOnce(queryLatitude, queryLongitude, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt < GEOID_FETCH_MAX_ATTEMPTS) {
        await delay(GEOID_FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

export async function lookupGsiGeoidHeight(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  pointSpecific = false
): Promise<number> {
  validatedCoordinate(latitude, longitude);
  // 地域近似モードは0.01度代表点を仕様として使う。地点別モードは原座標を送信し、
  // キャッシュキーだけ約1mm相当の8桁へ量子化する。
  const cacheLatitude = Number(latitude.toFixed(pointSpecific ? 8 : 2));
  const cacheLongitude = Number(longitude.toFixed(pointSpecific ? 8 : 2));
  const queryLatitude = pointSpecific ? latitude : cacheLatitude;
  const queryLongitude = pointSpecific ? longitude : cacheLongitude;
  const key = `${cacheLatitude},${cacheLongitude},${pointSpecific ? "point" : "regional"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const request = fetchGeoidHeightWithRetry(queryLatitude, queryLongitude, signal);
  return cache.set(key, request);
}
