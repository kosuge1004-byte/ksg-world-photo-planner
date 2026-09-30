import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as lookupElevation } from "../../functions/api/gsi-elevation.ts";
import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import {
  gsiElevationMemoryCacheStatsForTests,
  lookupGsiElevations,
  resetGsiElevationMemoryCacheForTests,
  tileCoordinates,
} from "../../server/gsiElevation.ts";

class MemoryKv {
  async get() { return null; }
  async put() {}
}

class MemoryBudgetDb {
  values = new Map();

  prepare() {
    return {
      bind: (key, increment, limit) => ({
        first: async () => {
          const current = this.values.get(key) ?? 0;
          if (current + increment > limit) return null;
          const writes = current + increment;
          this.values.set(key, writes);
          return { writes };
        },
      }),
    };
  }
}

class MemoryR2 {
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }
  values = new Map();
  getCount = 0;
  putCount = 0;

  async get(key) {
    this.getCount += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const value = this.values.get(key);
    return value === undefined
      ? null
      : { arrayBuffer: async () => value.slice(0) };
  }

  async put(key, value) {
    this.putCount += 1;
    this.values.set(key, value.slice(0));
  }
}

function persistentEmptyKey(latitude, longitude) {
  const { x, y } = tileCoordinates({ latitude, longitude }, 14);
  return `gsi-decoded-dem-v2/dem_png/14/${x}/${y}.bin`;
}

function eventContext(latitude, longitude, r2) {
  const waitUntilPromises = [];
  const request = new Request("https://example.test/api/gsi-elevation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{ latitude, longitude, maximumDetail: "10m", interpolationMode: "neutral" }],
    }),
  });
  return {
    context: {
      request,
      env: {
        NETWORK_CACHE: r2,
        SPOT_SEARCH_JOBS: new MemoryKv(),
        R2_WRITE_BUDGET_DB: new MemoryBudgetDb(),
      },
      waitUntil(promise) { waitUntilPromises.push(promise); },
    },
    waitUntilPromises,
  };
}

async function call(latitude, longitude, r2) {
  const { context, waitUntilPromises } = eventContext(latitude, longitude, r2);
  const response = await lookupElevation(context);
  return { response, body: await response.json(), waitUntilPromises };
}

test("elevation API distinguishes R2, memory, shared and bypass cache paths", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamFetches = 0;
  globalThis.fetch = async () => {
    upstreamFetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(null, { status: 404 });
  };

  try {
    const r2HitCache = new MemoryR2();
    const r2HitPoint = [35.0, 136.0];
    r2HitCache.values.set(persistentEmptyKey(...r2HitPoint), new Uint8Array([0]).buffer);

    const r2Hit = await call(...r2HitPoint, r2HitCache);
    assert.equal(r2Hit.response.status, 200);
    assert.deepEqual(r2Hit.body.samples, [{ heightMeters: null, source: null }]);
    assert.equal(r2Hit.body.tileCacheHit, 1);
    assert.equal(r2Hit.body.tileCacheMiss, 0);
    assert.equal(r2Hit.body.tileMemoryHit, 0);
    assert.equal(r2Hit.body.tileCacheShared, 0);
    assert.equal(r2Hit.body.tileCacheBypass, 0);
    assert.equal(upstreamFetches, 0, "R2 hit must not call GSI");
    const readsAfterInitialLookup = r2HitCache.getCount;

    const memoryHit = await call(...r2HitPoint, r2HitCache);
    assert.equal(memoryHit.body.tileMemoryHit, 1);
    assert.equal(memoryHit.body.tileCacheHit, 0);
    assert.equal(
      r2HitCache.getCount,
      readsAfterInitialLookup,
      "memory hit must not read R2 again"
    );
    assert.equal(upstreamFetches, 0, "memory hit must not call GSI");

    const missCache = new MemoryR2();
    const miss = await call(35.2, 136.2, missCache);
    assert.equal(miss.body.tileCacheMiss, 1);
    assert.equal(miss.body.tileCacheBypass, 0);
    assert.equal(upstreamFetches, 1, "R2 miss must fall through to GSI");
    await Promise.all(miss.waitUntilPromises);
    assert.equal(missCache.putCount, 1, "confirmed GSI 404 must persist an empty tile");

    const bypass = await call(35.4, 136.4, undefined);
    assert.equal(bypass.body.tileCacheBypass, 1);
    assert.equal(bypass.body.tileCacheMiss, 0);
    assert.equal(upstreamFetches, 2, "R2 bypass must preserve the GSI fallback");

    // 2026-09-30: 契約変更。以前は同時に来た別リクエストが取得中Promiseを共有して
    // いたが、Cloudflare Workersでは所有リクエストが中断されるとそのPromiseが永久に
    // 解決されず、isolate全体の標高APIが無応答になった（実機障害の根本原因）。
    // 取得中の共有はリクエスト内に限り、リクエスト間では完了済みの値だけを共有する。
    const sharedCache = new MemoryR2(20);
    const beforeSharedFetches = upstreamFetches;
    const [owner, follower] = await Promise.all([
      call(35.6, 136.6, sharedCache),
      call(35.6, 136.6, sharedCache),
    ]);
    assert.equal(owner.body.tileCacheShared + follower.body.tileCacheShared, 0,
      "in-flight lookups must never be shared across Cloudflare requests");
    assert.equal(owner.body.tileCacheMiss + follower.body.tileCacheMiss, 2);
    assert.equal(upstreamFetches - beforeSharedFetches, 2);
    const afterSettled = await call(35.6, 136.6, sharedCache);
    assert.equal(afterSettled.body.tileMemoryHit, 1, "a settled tile is reused across requests");
    assert.equal(upstreamFetches - beforeSharedFetches, 2, "settled reuse must not refetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transient tile failures are not misreported as authoritative DEM no-data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("temporary", { status: 503 });
  try {
    const { response, body } = await call(35.8123, 136.8123, undefined);
    assert.equal(response.status, 422);
    assert.match(String(body.error), /503/);
    assert.equal(body.samples, undefined,
      "a retryable transport failure must not become a successful null/null water sample");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function serializedDecodedTile(heightCentimeters) {
  const width = 256;
  const height = 256;
  const headerBytes = 9;
  const output = new ArrayBuffer(headerBytes + width * height * 4);
  const view = new DataView(output);
  view.setUint8(0, 1);
  view.setUint32(1, width, true);
  view.setUint32(5, height, true);
  for (let index = 0; index < width * height; index += 1) {
    view.setInt32(headerBytes + index * 4, heightCentimeters, true);
  }
  return output;
}

function tileCenter(x, y, zoom) {
  const scale = 2 ** zoom;
  const longitude = (x + 0.5) / scale * 360 - 180;
  const mercator = Math.PI - 2 * Math.PI * (y + 0.5) / scale;
  const latitude = Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
  return { latitude, longitude };
}

test("scattered 2,048-point-capable lookups keep decoded PNG cache below its byte budget", async (t) => {
  resetGsiElevationMemoryCacheForTests();
  const record = serializedDecodedTile(12_345);
  const objects = new Map();
  const points = [];
  for (let row = 0; row < 10; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const probe = { latitude: 27 + row * 0.3, longitude: 127 + column * 0.3 };
      const coordinate = tileCoordinates(probe, 14);
      objects.set(
        `gsi-decoded-dem-v2/dem_png/14/${coordinate.x}/${coordinate.y}.bin`,
        record
      );
      points.push({
        ...tileCenter(coordinate.x, coordinate.y, 14),
        maximumDetail: "10m",
        interpolationMode: "neutral",
      });
    }
  }
  configureServerRuntime({
    persistentCache: {
      async get(key) { return objects.get(key) ?? null; },
      async getWithStatus(key) {
        const value = objects.get(key) ?? null;
        return { status: value ? "hit" : "miss", value };
      },
      async put() {},
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("all stress-test tiles must come from the local R2 adapter");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureServerRuntime({});
    resetGsiElevationMemoryCacheForTests();
  });

  const samples = await lookupGsiElevations(points);
  assert.equal(samples.length, points.length);
  assert.ok(samples.every((sample) =>
    sample.source === "DEM10B" && Math.abs(sample.heightMeters - 123.45) < 1e-9
  ));
  const stats = gsiElevationMemoryCacheStatsForTests();
  assert.ok(stats.bytes <= stats.maximumBytes, JSON.stringify(stats));
  assert.ok(stats.entries <= stats.maximumEntries, JSON.stringify(stats));
  assert.ok(stats.entries < points.length, "the byte budget should evict old decoded data tiles");
});
