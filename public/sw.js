const SHELL_CACHE = "astrosight-shell-v1";
const CORE_FILES = [
  "/",
  "/manifest.webmanifest",
  "/app-icon-192.png",
  "/app-icon-512.png",
];

// 標準3D表示（Googleタイルモードではない）で使う地図データのうち、
// 保存・キャッシュしてよいことを確認済みのホストだけを対象にする。
//   - cyberjapandata.gsi.go.jp : 国土地理院タイル（地理院タイル利用規約で
//     複製・加工・保存が原則自由）
//   - tile.plateauview.mlit.go.jp / api.plateauview.mlit.go.jp : PLATEAU
//     地形・建物タイル（国交省オープンデータ、CC BY 4.0相当）
//
// 重要: Google Photorealistic 3D Tiles（Googleタイルモード）はこのホスト
// 一覧に含めない。Map Tiles APIの利用規約は事前取得・キャッシュ・保存・
// オフライン利用を明確に禁止しているため、ドメイン単位で構造的に除外する
// （アプリ側のモード判定に依存せず、Google由来のホストへは常に触れない）。
const CACHEABLE_TILE_HOSTS = [
  "cyberjapandata.gsi.go.jp",
  "tile.plateauview.mlit.go.jp",
  "api.plateauview.mlit.go.jp",
];
const TILE_CACHE = "astrosight-tiles-v1";
// 端末容量を無制限に消費しないよう、保存件数に上限を設ける。厳密なLRUでは
// なく、上限を超えたら挿入順の古いものから間引く簡易実装（性能キャッシュ
// のため、これで十分）。
const TILE_CACHE_MAX_ENTRIES = 6000;
const TILE_CACHE_TRIM_MARGIN = 200;
let tileTrimInFlight = null;

async function trimTileCache() {
  if (tileTrimInFlight) return tileTrimInFlight;
  tileTrimInFlight = (async () => {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    const overBy = keys.length - TILE_CACHE_MAX_ENTRIES;
    if (overBy <= 0) return;
    const removeCount = overBy + TILE_CACHE_TRIM_MARGIN;
    await Promise.all(
      keys.slice(0, Math.min(removeCount, keys.length)).map((key) => cache.delete(key))
    );
  })();
  try {
    await tileTrimInFlight;
  } finally {
    tileTrimInFlight = null;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(CORE_FILES.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (response.ok) await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("astrosight-shell-") && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data !== "CLEAR_TILE_CACHE") return;
  event.waitUntil(
    caches.delete(TILE_CACHE).then(() => {
      const client = event.source;
      if (client && "postMessage" in client) {
        client.postMessage("TILE_CACHE_CLEARED");
      }
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (CACHEABLE_TILE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        // opaqueレスポンス（CORSヘッダーが無い応答）はstatusが常に0で
        // okがfalseになるが、Cache APIへはそのまま保存・再生してよい。
        // 明確な失敗（ネットワークエラー等）と区別するため、レスポンスが
        // 得られたこと自体を保存条件とする。
        if (response && (response.ok || response.type === "opaque")) {
          event.waitUntil(
            cache.put(request, response.clone()).then(() => trimTileCache())
          );
        }
        return response;
      } catch (error) {
        // オフライン等でネットワークが失敗した場合、キャッシュに無ければ
        // 素直に失敗させる（地図表示側が既存のタイムアウト・フォールバック
        // 処理を持っているため、ここで代替表示を作る必要はない）。
        throw error;
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  const cacheableStaticFile = url.pathname.startsWith("/assets/") ||
    CORE_FILES.includes(url.pathname);
  if (!cacheableStaticFile) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
