import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGsiElevationSamples,
  getGsiElevationCacheStats,
  resetGsiElevationCacheStats,
} from "../../src/cesium/gsiElevationClient.ts";
import { isAbortError } from "../../src/utils/runtimeErrors.ts";

function points(count) {
  return Array.from({ length: count }, (_, index) => ({
    latitude: 35 + index * 0.0001,
    longitude: 136 + index * 0.0001,
    maximumDetail: "1m",
  }));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

test("large DEM requests split until Cloudflare can complete them", async () => {
  const requestSizes = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fetcher = async (_url, init) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const requested = JSON.parse(init.body).points;
    requestSizes.push(requested.length);
    activeRequests -= 1;
    if (requested.length > 8) {
      return jsonResponse({ error: "upstream timeout" }, 524);
    }
    return jsonResponse({
      samples: requested.map((_point, index) => ({
        heightMeters: 100 + index,
        source: "DEM5A",
      })),
    });
  };

  const result = await fetchGsiElevationSamples(points(100), undefined, fetcher);

  assert.equal(result.samples.length, 100);
  assert.equal(result.failedPointCount, 0);
  assert.ok(result.samples.every((sample) => sample.source === "DEM5A"));
  // 2026-09-01/09-02の並列分割変更後、100点（PARALLEL_SPLIT_MIN_POINTS=96以上）は
  // 最初からchunkSizeForRequest(100)=48点ずつ（ceil(100/48)=3バッチ: 48,48,4）に
  // 分割して送られる。48点バッチは8点超のため524で失敗し、24→12→6と半分に
  // 分割しながら再送され、6点(MIN_RECOVERY_SPLIT_SIZE=8以下)で成功する。
  assert.ok(requestSizes.includes(48));
  assert.ok(requestSizes.includes(24));
  assert.ok(requestSizes.includes(12));
  assert.ok(requestSizes.some((size) => size <= 8));
  assert.ok(Math.max(...requestSizes) <= 1024);
  // グローバル共有キュー（sharedQueue/MAX_CONCURRENT_REQUESTS）が唯一の実行主体
  // であり、再帰的な分割がいくつ並行していても同時実行数はアプリ全体で
  // MAX_CONCURRENT_REQUESTS(10)を超えない。
  assert.ok(maximumActiveRequests <= 10);
});

test("an unrecoverable DEM point does not discard its neighboring points", async () => {
  const fetcher = async (_url, init) => {
    const requested = JSON.parse(init.body).points;
    if (requested.some((point) => point.latitude === 35)) {
      return new Response("gateway failure", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }
    return jsonResponse({
      samples: requested.map(() => ({ heightMeters: 50, source: "DEM10B" })),
    });
  };

  const result = await fetchGsiElevationSamples(points(16), undefined, fetcher);

  // 2026-08-27追記: 以前は「失敗したら1点単位まで無限に分割して再送する」
  // 設計だったため、失敗する点(緯度35)だけが隔離され、周辺は正常に
  // 取得できていた。しかしこれが実機で「64点のバッチが最悪1点単位まで
  // 分裂し、497件のリクエストに膨れ上がる」輻輳の悪化を引き起こしたため、
  // 「MIN_RECOVERY_SPLIT_SIZE(8点)より細かくは分割しない」という安全策に
  // 変更した（gsiElevationClient.tsのコメント参照）。そのため、失敗する
  // 点を含む最小8点のバッチは、その8点全体が失敗扱いになる
  // （1点だけが隔離されるわけではない）。
  assert.equal(result.samples.length, 16);
  assert.equal(result.failedPointCount, 8, "8点floorにより、失敗点を含む8点のバッチ全体が失敗扱いになる");
  assert.equal(result.samples.slice(0, 8).every((sample) => sample.source === null), true);
  assert.equal(result.samples.slice(8).every((sample) => sample.source === "DEM10B"), true);
});

test("DEM requests preserve user cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchGsiElevationSamples(points(1), controller.signal, async () => {
      throw new Error("fetch should not run");
    }),
    (error) => isAbortError(error)
  );
});

test("tile cache diagnostics aggregate every server cache path across batches", async () => {
  resetGsiElevationCacheStats();
  let calls = 0;
  const fetcher = async (_url, init) => {
    calls += 1;
    const requested = JSON.parse(init.body).points;
    return jsonResponse({
      samples: requested.map(() => ({ heightMeters: 10, source: "DEM10B" })),
      tileCacheHit: 1,
      tileCacheMiss: 2,
      tileMemoryHit: 3,
      tileCacheShared: 4,
      tileCacheBypass: 5,
    });
  };

  const result = await fetchGsiElevationSamples(points(1500), undefined, fetcher);

  // 2026-09-01/09-02の並列分割変更（chunkSizeForRequest / MAX_CONCURRENT_REQUESTS=10）
  // により、96点以上はMAX_CONCURRENT_REQUESTS本へほぼ均等分割されるようになった。
  // 1500点はceil(1500/10)=150点ずつ、ちょうど10バッチになる。
  assert.equal(calls, 10, "1500 points should split into 10 even 150-point batches");
  assert.equal(result.tileCacheHitCount, 10);
  assert.equal(result.tileCacheMissCount, 20);
  assert.equal(result.tileMemoryHitCount, 30);
  assert.equal(result.tileCacheSharedCount, 40);
  assert.equal(result.tileCacheBypassCount, 50);
  assert.deepEqual(getGsiElevationCacheStats(), {
    hit: 10,
    miss: 20,
    memoryHit: 30,
    shared: 40,
    bypass: 50,
  });
});

test("invalid cache diagnostics cannot corrupt search totals", async () => {
  resetGsiElevationCacheStats();
  const fetcher = async (_url, init) => {
    const requested = JSON.parse(init.body).points;
    return jsonResponse({
      samples: requested.map(() => ({ heightMeters: 10, source: "DEM10B" })),
      tileCacheHit: -1,
      tileCacheMiss: 1.5,
      tileMemoryHit: Number.MAX_SAFE_INTEGER + 1,
      tileCacheShared: "3",
      tileCacheBypass: null,
    });
  };

  const result = await fetchGsiElevationSamples(points(1), undefined, fetcher);
  assert.equal(result.tileCacheHitCount, 0);
  assert.equal(result.tileCacheMissCount, 0);
  assert.equal(result.tileMemoryHitCount, 0);
  assert.equal(result.tileCacheSharedCount, 0);
  assert.equal(result.tileCacheBypassCount, 0);
});
