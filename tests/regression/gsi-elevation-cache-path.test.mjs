import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as lookupElevation } from "../../functions/api/gsi-elevation.ts";
import { tileCoordinates } from "../../server/gsiElevation.ts";

class MemoryKv {
  async get() { return null; }
  async put() {}
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
      env: { NETWORK_CACHE: r2, SPOT_SEARCH_JOBS: new MemoryKv() },
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

    const memoryHit = await call(...r2HitPoint, r2HitCache);
    assert.equal(memoryHit.body.tileMemoryHit, 1);
    assert.equal(memoryHit.body.tileCacheHit, 0);
    assert.equal(r2HitCache.getCount, 1, "memory hit must not read R2 again");
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

    const sharedCache = new MemoryR2(20);
    const beforeSharedFetches = upstreamFetches;
    const [owner, follower] = await Promise.all([
      call(35.6, 136.6, sharedCache),
      call(35.6, 136.6, sharedCache),
    ]);
    assert.equal(owner.body.tileCacheMiss + follower.body.tileCacheMiss, 1);
    assert.equal(owner.body.tileCacheShared + follower.body.tileCacheShared, 1);
    assert.equal(
      upstreamFetches - beforeSharedFetches,
      1,
      "concurrent callers must share one R2/GSI tile lookup"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
