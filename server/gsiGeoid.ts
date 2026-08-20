import { keepServerTaskAlive, serverPersistentCache } from "./cloudflareRuntime.ts";
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

// 国土地理院の測量計算サイト公式ページに明記されている制限：
// 「ジオイド高計算（ジオイド2024日本とその周辺）...は負荷が大きいため
// 10秒間で3回」（同一IPアドレスからのリクエスト）。
// https://vldb.gsi.go.jp/sokuchi/surveycalc/main.html
// 先読みWorker・ユーザー向けAPIどちらの経路でも、実際にGSIへ問い合わせる
// 直前（キャッシュヒット時は素通り）でこの制限を守るよう、プロセス内で
// グローバルに間隔を管理する。公式値ちょうどではなく、余裕を持たせて
// 「10秒に3回」ではなく「10秒に1回」（5秒に1回未満にはしない）にとどめる。
const MIN_REQUEST_INTERVAL_MS = 3_500;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function waitForRateLimitSlot(): Promise<void> {
  const next = requestQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();
  });
  requestQueue = next.catch(() => {});
  return next;
}

async function fetchGeoidHeightOnce(
  queryLatitude: number,
  queryLongitude: number,
  signal?: AbortSignal
): Promise<number> {
  await waitForRateLimitSlot();
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

/**
 * 永続キャッシュ（R2）の読み書き。以前は/api/gsi-geoid（ユーザー向けAPI）
 * だけがR2を使い、先読みWorker（workers/prewarm-landmark-cron.ts）は
 * プロセス内メモリキャッシュ（LruPromiseCache、Workerインスタンスの寿命の
 * 間だけ有効）にしか書き込んでいなかった。そのため先読みで取得した値が
 * ユーザー向けAPI側のキャッシュへ一切共有されず、「先読みの仕組みは
 * あるのに実質何も貯金されていない」状態になっていた。
 * ここへ永続キャッシュを組み込み、どちらの経路からでも同じR2キャッシュを
 * 共有できるようにする（DEMタイルキャッシュ：server/gsiElevation.tsの
 * readPersistentTile/writePersistentTileと同じ方式）。
 */
function persistentGeoidKey(key: string): string {
  return `geoid/v1/${key}.json`;
}

async function readPersistentGeoidHeight(key: string): Promise<number | null> {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return null;
  try {
    const bytes = await persistentCache.get(persistentGeoidKey(key), { type: "arrayBuffer" });
    if (!(bytes instanceof ArrayBuffer)) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { geoidHeightMeters?: unknown };
    return typeof parsed.geoidHeightMeters === "number" && Number.isFinite(parsed.geoidHeightMeters)
      ? parsed.geoidHeightMeters
      : null;
  } catch {
    // ローカル開発やR2未設定環境では永続キャッシュを使わず従来処理を継続する。
    return null;
  }
}

function writePersistentGeoidHeight(key: string, geoidHeightMeters: number): void {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return;
  const payload = new TextEncoder().encode(JSON.stringify({ geoidHeightMeters })).buffer as ArrayBuffer;
  keepServerTaskAlive(
    persistentCache.put(persistentGeoidKey(key), payload).catch(() => {
      // 永続化の失敗は探索結果に影響させない（次回また通常取得へフォールバック）。
    })
  );
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

  const request = (async () => {
    const persisted = await readPersistentGeoidHeight(key);
    if (persisted !== null) return persisted;
    const height = await fetchGeoidHeightWithRetry(queryLatitude, queryLongitude, signal);
    writePersistentGeoidHeight(key, height);
    return height;
  })();
  return cache.set(key, request);
}
