import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  computeBearingProfileBatch,
  isBearingProfileBatchRequest,
  lookupBearingProfileGeoidHeights,
} from "../../server/bearingProfileBatch.ts";
import { fetchBearingProfileBatch } from "../../src/cache/bearingProfileBatchClient.ts";
import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import { calculateKarneyDestinationPoint } from "../../src/geodesy/karneyGeodesic.ts";
import { ADAPTIVE_COARSE_MAX_SPAN_METERS } from "../../src/cesium/tripodCandidates.ts";
import { lookupLocalJpgeo2024Height } from "../../server/jpgeo2024Local.ts";
import {
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  precomputedBearingProfileObjectKey,
} from "../../server/precomputedBearingProfiles.ts";
import { lookupR2PrecomputedBearingProfile } from "../../server/publishedPrecomputedBearingProfiles.ts";
import { onRequest as bearingProfileBatchEndpoint } from "../../functions/api/bearing-profile-batch.ts";
import { onRequest as apiMiddleware } from "../../functions/_middleware.ts";

const request = {
  subjectPoint: { latitude: 35.36, longitude: 136.81, height: 100 },
  cameraSettings: { lensCenterHeightMeters: 1.6 },
  bearings: [0, 90],
  maxDistanceMeters: 1_000,
};

test("bearing batch preserves every coordinate, detail and neutral interpolation", async () => {
  const elevationRequests = [];
  let geoidPointCount = 0;
  const result = await computeBearingProfileBatch(request, undefined, {
    lookupElevations: async (points) => {
      elevationRequests.push(...points);
      return points.map((_point, index) => index === 0
        ? { heightMeters: null, source: null }
        : { heightMeters: 100, source: "DEM5A" });
    },
    lookupGeoidHeights: async (points) => {
      geoidPointCount += points.length;
      return points.map(() => 38);
    },
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });

  assert.equal(result.version, 2);
  assert.equal(result.requestedBearingCount, 2);
  assert.equal(result.failedBearings.length, 0);
  assert.equal(result.profiles.length, 2);
  assert.equal(result.pointCount, elevationRequests.length);
  assert.equal(geoidPointCount, result.pointCount,
    "every terrain coordinate must retain its point-specific geoid value");
  assert.ok(elevationRequests.every((point) =>
    point.maximumDetail === "1m" && point.interpolationMode === "neutral"
  ));

  assert.equal("points" in result.profiles[0], false,
    "wire response must not repeat coordinates for every point");
  const expanded = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(result)
  );
  assert.ok(expanded);
  const first = expanded.profiles[0].points[0];
  const expected = calculateKarneyDestinationPoint(
    request.subjectPoint,
    request.bearings[0],
    first.distanceMeters
  );
  assert.equal(first.latitude, expected.latitude);
  assert.equal(first.longitude, expected.longitude);
  assert.equal(first.ellipsoidalHeightMeters, 38,
    "authoritative DEM no-data remains the existing H=0 water convention");
  assert.equal(first.elevationSource, null);
  assert.ok(expanded.profiles.flatMap((profile) => profile.points).slice(1)
    .every((point) => point.ellipsoidalHeightMeters === 138));
  assert.ok(expanded.profiles.flatMap((profile) => profile.points).slice(1)
    .every((point) => point.elevationSource === "DEM5A"));
  let elevationRequestIndex = 0;
  for (const profile of expanded.profiles) {
    profile.points.forEach((point) => {
      const reconstructed = calculateKarneyDestinationPoint(
        request.subjectPoint,
        profile.bearingDegrees,
        point.distanceMeters
      );
      assert.equal(point.latitude, reconstructed.latitude);
      assert.equal(point.longitude, reconstructed.longitude);
      assert.equal(point.latitude, elevationRequests[elevationRequestIndex].latitude);
      assert.equal(point.longitude, elevationRequests[elevationRequestIndex].longitude);
      elevationRequestIndex += 1;
    });
  }
  assert.equal(elevationRequestIndex, elevationRequests.length);

  const rollingDeployV1 = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(expanded)
  );
  assert.deepEqual(rollingDeployV1, expanded,
    "the client must retain compatibility with a previously deployed v1 endpoint");
});

test("a complete precomputed profile bypasses every DEM and geoid calculation", async () => {
  const distancesMeters = [8, request.maxDistanceMeters];
  const precomputed = {
    version: 2,
    distancesMeters,
    profiles: request.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [101.25, 102.5],
      elevationSources: ["DEM1A", "DEM5A"],
      computedAtIso: "2026-09-28T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: request.bearings.length,
    pointCount: request.bearings.length * distancesMeters.length,
  };
  let precomputedLookups = 0;
  const result = await computeBearingProfileBatch(request, undefined, {
    lookupPrecomputed: async (actualRequest) => {
      precomputedLookups += 1;
      assert.deepEqual(actualRequest, request);
      return precomputed;
    },
    lookupElevations: async () => { throw new Error("DEM must not run"); },
    lookupGeoidHeights: async () => { throw new Error("geoid must not run"); },
    nowIso: () => "unreachable",
  });
  assert.equal(precomputedLookups, 1);
  assert.deepEqual(result, precomputed);
});

test("one immutable R2 object supplies any requested bearing subset", async (t) => {
  t.after(() => configureServerRuntime({}));
  const storedBearings = [0, 90, 180];
  const stored = {
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    subject: {
      name: "test target",
      latitude: request.subjectPoint.latitude,
      longitude: request.subjectPoint.longitude,
    },
    maxDistanceMeters: request.maxDistanceMeters,
    generatedAt: "2026-09-29T00:00:00.000Z",
    response: {
      version: 2,
      distancesMeters: [8, request.maxDistanceMeters],
      profiles: storedBearings.map((bearingDegrees) => ({
        bearingDegrees,
        ellipsoidalHeightsMeters: [100 + bearingDegrees, 101 + bearingDegrees],
        elevationSources: ["DEM1A", "DEM5A"],
        computedAtIso: "2026-09-29T00:00:00.000Z",
      })),
      failedBearings: [],
      requestedBearingCount: storedBearings.length,
      pointCount: storedBearings.length * 2,
    },
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(stored), "utf8"));
  const bytes = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength
  );
  const expectedKey = await precomputedBearingProfileObjectKey({
    latitude: request.subjectPoint.latitude,
    longitude: request.subjectPoint.longitude,
    maxDistanceMeters: request.maxDistanceMeters,
  });
  const keys = [];
  configureServerRuntime({
    persistentCache: {
      async get() { return null; },
      async getWithStatus(key) {
        keys.push(key);
        return { status: "hit", value: bytes };
      },
      async put() {},
    },
  });
  const result = await lookupR2PrecomputedBearingProfile(request);
  assert.deepEqual(keys, [expectedKey]);
  assert.ok(result);
  assert.equal(result.precomputed, true);
  assert.deepEqual(result.profiles.map((profile) => profile.bearingDegrees), request.bearings);
  assert.equal(result.requestedBearingCount, request.bearings.length);
  assert.equal(result.pointCount, request.bearings.length * 2);

  const browserResult = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(stored)
  );
  assert.ok(browserResult,
    "the browser must validate and select requested bearings from the full R2 envelope");
  assert.equal(browserResult.precomputed, true);
  assert.deepEqual(browserResult.profiles.map((profile) => profile.bearingDegrees), request.bearings);
});

test("production batch geoid path uses each original JPGEO2024 coordinate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Japanese batch geoid lookup must not use the legacy CGI");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // This is the largest observed exact-vs-former-regional difference in the
  // 50 km Tokyo audit. It protects against accidentally restoring the old
  // 0.025° representative plus 0.01° rounding path.
  const point = { latitude: 35.713146785509316, longitude: 139.93724305019094 };
  const [actual] = await lookupBearingProfileGeoidHeights([point]);
  const exact = lookupLocalJpgeo2024Height(point.latitude, point.longitude);
  // The former algorithm reused the first point in this 0.025° region, then
  // rounded that representative to (35.74, 139.91) before interpolation.
  const formerRegional = lookupLocalJpgeo2024Height(35.74, 139.91);
  assert.equal(typeof exact, "number");
  assert.equal(typeof formerRegional, "number");
  assert.equal(actual, exact);
  assert.ok(Math.abs(exact - formerRegional) > 0.3,
    "the precision fixture must distinguish exact and former regional geoid heights");
});

test("batch geoid fallback keeps the original point-specific coordinate", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return Response.json({ OutputData: { geoidHeight: "12.3456" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const point = { latitude: 49.1234567, longitude: 159.1234567 };
  assert.deepEqual(await lookupBearingProfileGeoidHeights([point]), [12.3456]);
  assert.equal(requestedUrls.length, 1);
  const query = new URL(requestedUrls[0]).searchParams;
  assert.equal(query.get("latitude"), String(point.latitude));
  assert.equal(query.get("longitude"), String(point.longitude));
});

test("compact batch safely covers the full 360-bearing, 50 km contract", async () => {
  const fullRequest = {
    ...request,
    bearings: Array.from({ length: 360 }, (_, index) => index),
    maxDistanceMeters: 50_000,
  };
  let maximumElevationLookupPoints = 0;
  let geoidLookupCallCount = 0;
  let sourceIndex = 0;
  const sources = ["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B", null];
  const result = await computeBearingProfileBatch(fullRequest, undefined, {
    lookupElevations: async (points) => {
      maximumElevationLookupPoints = Math.max(maximumElevationLookupPoints, points.length);
      return points.map((point) => {
        const source = sources[sourceIndex % sources.length];
        sourceIndex += 1;
        return {
          heightMeters: source === null
            ? null
            : Math.sin(point.latitude * 17 + point.longitude) * 9_999.123456789012,
          source,
        };
      });
    },
    lookupGeoidHeights: async (points) => {
      geoidLookupCallCount += 1;
      return points.map((point) =>
        Math.cos(point.latitude * 3 - point.longitude) * 80.123456789012
      );
    },
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });

  assert.equal(result.version, 2);
  assert.equal(result.requestedBearingCount, 360);
  assert.equal(result.profiles.length, 360);
  assert.equal(result.pointCount, 360 * result.distancesMeters.length);
  assert.ok(maximumElevationLookupPoints <= 2_048);
  assert.ok(geoidLookupCallCount > 1,
    "360 bearings must be processed in bounded live-coordinate chunks");
  const raw = Buffer.from(JSON.stringify(result));
  assert.ok(raw.length < 64 * 1024 * 1024,
    "the validated uncompressed profile must stay inside the reader safety limit");
  assert.ok(gzipSync(raw).length < 16 * 1024 * 1024,
    "the immutable profile must stay inside the static/R2 compressed-file limit");
});

test("compact response keeps per-bearing failures and rejects incomplete envelopes", async () => {
  const failedResult = await computeBearingProfileBatch(request, undefined, {
    lookupElevations: async (points) => points.map((_point, index) => {
      return index < points.length / 2
        ? { heightMeters: 100, source: "DEM5A" }
        : { heightMeters: null, source: "DEM5A" };
    }),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-09-26T00:00:00.000Z",
  });
  assert.equal(failedResult.version, 2);
  assert.equal(failedResult.profiles.length, 1);
  assert.deepEqual(failedResult.failedBearings, [{
    bearingDegrees: 90,
    reason: "DEM標高の応答が不正な地点があります",
  }]);

  const expanded = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(failedResult)
  );
  assert.ok(expanded);
  assert.equal(expanded.profiles.length, 1);
  assert.deepEqual(expanded.failedBearings, failedResult.failedBearings);

  const incomplete = structuredClone(failedResult);
  incomplete.failedBearings = [];
  assert.equal(await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json(incomplete)
  ), null, "an unaccounted bearing must fall back to the established direct path");
});

test("invalid or duplicate bearings are rejected before terrain work", () => {
  assert.equal(isBearingProfileBatchRequest(request), true);
  assert.equal(isBearingProfileBatchRequest({ ...request, bearings: [1, 1] }), false);
  assert.equal(isBearingProfileBatchRequest({ ...request, maxDistanceMeters: 50_001 }), false);
  assert.equal(isBearingProfileBatchRequest({
    ...request,
    subjectPoint: {
      ...request.subjectPoint,
      latitude: 35.3606255,
      longitude: 138.7273634,
    },
    maxDistanceMeters: 100_000,
  }), true, "Mount Fuji alone accepts the registered 100km contract");
  assert.equal(isBearingProfileBatchRequest({
    ...request,
    subjectPoint: {
      ...request.subjectPoint,
      latitude: 35.3606255,
      longitude: 138.7273634,
    },
    maxDistanceMeters: 99_999,
  }), false, "wide requests must match Mount Fuji's exact registered range");
  assert.equal(isBearingProfileBatchRequest({
    ...request,
    subjectPoint: { ...request.subjectPoint, latitude: Number.NaN },
  }), false);
});

test("Mount Fuji's 100km profile reaches the endpoint without widening the 30m terrain spacing", async () => {
  const fujiRequest = {
    ...request,
    subjectPoint: {
      ...request.subjectPoint,
      latitude: 35.3606255,
      longitude: 138.7273634,
    },
    bearings: [0],
    maxDistanceMeters: 100_000,
  };
  const result = await computeBearingProfileBatch(fujiRequest, undefined, {
    lookupElevations: async (points) => points.map(() => ({ heightMeters: 100, source: "DEM10B" })),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-10-02T00:00:00.000Z",
  });
  assert.equal(result.failedBearings.length, 0);
  assert.equal(result.distancesMeters.at(-1), 100_000);
  assert.ok(result.distancesMeters.length > 3_300);
  assert.ok(result.distancesMeters.slice(1).every((distance, index) =>
    distance - result.distancesMeters[index] <= ADAPTIVE_COARSE_MAX_SPAN_METERS + 1e-9
  ));
});

test("batch client falls back on an unavailable endpoint and preserves user abort", async () => {
  const unavailable = await fetchBearingProfileBatch(
    request,
    undefined,
    async () => new Response("missing", { status: 404 })
  );
  assert.equal(unavailable, null);

  // 2026-09-30: 503も例外ではなくmiss（呼び出し側は1方位経路で続行する）。
  assert.equal(await fetchBearingProfileBatch(
    request,
    undefined,
    async () => Response.json({
      code: "PRECOMPUTED_PROFILE_UNAVAILABLE",
      error: "登録スポットの計算済み地形データを読み出せません。",
    }, { status: 503 })
  ), null);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchBearingProfileBatch(request, controller.signal, async () => {
      throw new Error("must not fetch");
    }),
    { name: "AbortError" }
  );
});

test("Pages batch endpoint fails registered-profile misses quickly instead of computing", async () => {
  const body = {
    ...request,
    subjectPoint: {
      latitude: 35.7100627,
      longitude: 139.8107004,
      height: 634,
    },
    bearings: [0],
    maxDistanceMeters: 10_000,
  };
  const response = await bearingProfileBatchEndpoint({
    request: new Request("https://example.test/api/bearing-profile-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env: {},
    waitUntil() {},
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    code: "PRECOMPUTED_PROFILE_UNAVAILABLE",
    error: "この内蔵スポットの計算済み地形データを取得できませんでした。",
  });
});

test("Pages batch endpoint uses the E-drive exact calculator as the final origin", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const body = {
    ...request,
    subjectPoint: {
      latitude: 35.7101127,
      longitude: 139.8107504,
      height: 12,
    },
    bearings: [0],
    maxDistanceMeters: 1_000,
  };
  const exact = await computeBearingProfileBatch(body, undefined, {
    lookupPrecomputed: async () => null,
    lookupElevations: async (points) => points.map(() => ({
      heightMeters: 100,
      source: "DEM5A",
    })),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-09-30T00:00:00.000Z",
  });
  exact.terrainProfileComplete = true;
  const requestedRoutes = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedRoutes.push(url.pathname);
    if (url.pathname === "/v1/bearing-profile/precomputed") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === "/v1/bearing-profile/compute") {
      return Response.json(exact);
    }
    throw new Error(`unexpected origin request: ${url.pathname}`);
  };
  const response = await bearingProfileBatchEndpoint({
    request: new Request("https://example.test/api/bearing-profile-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env: {
      LOCAL_DEM_API_URL: "https://dem-origin.example.test/v1/elevation/batch",
      LOCAL_DEM_ORIGIN_TOKEN: "o".repeat(48),
      LOCAL_DEM_ACCESS_CLIENT_ID: "test-client-id",
      LOCAL_DEM_ACCESS_CLIENT_SECRET: "s".repeat(48),
    },
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedRoutes, [
    "/v1/bearing-profile/precomputed",
    "/v1/bearing-profile/compute",
  ]);
  const result = await response.json();
  assert.equal(result.terrainProfileComplete, true);
  assert.equal(result.requestedBearingCount, 1);
  assert.equal(result.failedBearings.length, 0);
});

test("Pages batch endpoint stops arbitrary-coordinate downloads when E-drive is unavailable", async () => {
  const body = {
    ...request,
    subjectPoint: {
      latitude: 35.7101127,
      longitude: 139.8107504,
      height: 12,
    },
    bearings: [0],
    maxDistanceMeters: 1_000,
  };
  const response = await bearingProfileBatchEndpoint({
    request: new Request("https://example.test/api/bearing-profile-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env: {},
    waitUntil() {},
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "PROFILE_SOURCE_UNAVAILABLE",
    error: "この地点の地形データをまとめて取得できなかったため、1方位ずつ取得します（時間がかかります）。",
  });
});

test("Pages batch endpoint accepts Capacitor CORS preflight without terrain work", async () => {
  const response = await bearingProfileBatchEndpoint({
    request: new Request("https://example.test/api/bearing-profile-batch", {
      method: "OPTIONS",
      headers: {
        Origin: "https://localhost",
        "Access-Control-Request-Method": "POST",
      },
    }),
    env: {},
    waitUntil() {},
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
});

test("Pages API middleware allows only the installed app origins", async () => {
  const nativeResponse = await apiMiddleware({
    request: new Request("https://astrosight.pages.dev/api/gsi-elevation", {
      headers: { Origin: "https://localhost" },
    }),
    next: async () => Response.json({ ok: true }),
  });
  assert.equal(nativeResponse.headers.get("access-control-allow-origin"), "https://localhost");

  const foreignResponse = await apiMiddleware({
    request: new Request("https://astrosight.pages.dev/api/gsi-elevation", {
      headers: { Origin: "https://example.invalid" },
    }),
    next: async () => Response.json({ ok: true }),
  });
  assert.equal(foreignResponse.headers.get("access-control-allow-origin"), null);
});

test("Pages batch endpoint streams the R2 gzip without Worker-side inflation", async () => {
  const body = {
    ...request,
    subjectPoint: {
      latitude: 35.7100627,
      longitude: 139.8107004,
      height: 634,
    },
    bearings: [0],
    maxDistanceMeters: 10_000,
  };
  const stored = {
    schemaVersion: 1,
    format: PRECOMPUTED_BEARING_PROFILE_FORMAT,
    subject: {
      name: "東京スカイツリー",
      latitude: body.subjectPoint.latitude,
      longitude: body.subjectPoint.longitude,
    },
    maxDistanceMeters: body.maxDistanceMeters,
    generatedAt: "2026-09-29T00:00:00.000Z",
    response: {
      version: 2,
      distancesMeters: [8, 10_000],
      profiles: [{
        bearingDegrees: 0,
        ellipsoidalHeightsMeters: [38, 39],
        elevationSources: ["DEM1A", "DEM5A"],
        computedAtIso: "2026-09-29T00:00:00.000Z",
      }],
      failedBearings: [],
      requestedBearingCount: 1,
      pointCount: 2,
    },
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(stored), "utf8"));
  const budget = new Map();
  const NativeResponse = globalThis.Response;
  let response;
  let capturedEncodeBody = null;
  globalThis.Response = class extends NativeResponse {
    constructor(responseBody, init) {
      capturedEncodeBody = init?.encodeBody ?? null;
      super(responseBody, init);
    }
  };
  try {
    response = await bearingProfileBatchEndpoint({
      request: new Request("https://example.test/api/bearing-profile-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env: {
        NETWORK_CACHE: {
          async get() {
            return {
              async arrayBuffer() {
                return compressed.buffer.slice(
                  compressed.byteOffset,
                  compressed.byteOffset + compressed.byteLength
                );
              },
            };
          },
          async put() {},
        },
        SPOT_SEARCH_JOBS: { async get() { return null; }, async put() {} },
        R2_WRITE_BUDGET_DB: {
          prepare() {
            return {
              bind(key, increment, limit) {
                return {
                  async first() {
                    const next = (budget.get(key) ?? 0) + increment;
                    if (next > limit) return null;
                    budget.set(key, next);
                    return { writes: next };
                  },
                };
              },
            };
          },
        },
      },
      waitUntil() {},
    });
  } finally {
    globalThis.Response = NativeResponse;
  }
  assert.equal(response.status, 200);
  assert.equal(capturedEncodeBody, "manual");
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const streamed = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(streamed, compressed);
});

// ---------------------------------------------------------------------------
// 2026-09-30: Eドライブの計算結果をR2へ書き戻し、次回はR2で返す。
// ---------------------------------------------------------------------------
class WriteBackKv {
  async get() { return null; }
  async put() {}
}
class WriteBackBudgetDb {
  values = new Map();
  prepare() {
    return {
      bind: (key, increment, limit) => ({
        first: async () => {
          const current = this.values.get(key) ?? 0;
          if (current + increment > limit) return null;
          this.values.set(key, current + increment);
          return { writes: current + increment };
        },
      }),
    };
  }
}
class WriteBackR2 {
  values = new Map();
  puts = [];
  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : { arrayBuffer: async () => value.slice(0) };
  }
  async put(key, value) {
    this.puts.push(key);
    const bytes = value instanceof ArrayBuffer ? value : new Uint8Array(value).buffer;
    this.values.set(key, bytes.slice(0));
  }
}

async function callBatch(body, bucket, originFetch, { resetOrigin = true } = {}) {
  const { resetLocalDemGatewayForTests } = await import("../../server/localDemGateway.ts");
  if (resetOrigin) resetLocalDemGatewayForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = originFetch;
  const pending = [];
  try {
    const response = await bearingProfileBatchEndpoint({
      request: new Request("https://example.test/api/bearing-profile-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env: {
        NETWORK_CACHE: bucket,
        SPOT_SEARCH_JOBS: new WriteBackKv(),
        R2_WRITE_BUDGET_DB: new WriteBackBudgetDb(),
        LOCAL_DEM_API_URL: "https://dem-origin.example.test/v1/elevation/batch",
        LOCAL_DEM_ORIGIN_TOKEN: "o".repeat(48),
        LOCAL_DEM_ACCESS_CLIENT_ID: "test-client-id",
        LOCAL_DEM_ACCESS_CLIENT_SECRET: "s".repeat(48),
      },
      waitUntil(promise) { pending.push(promise); },
    });
    await Promise.all(pending);
    return response;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("E-drive results are written back to R2 and served from R2 while the PC is off", async () => {
  const body = {
    ...request,
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    bearings: [0, 90, 180],
    maxDistanceMeters: 1_000,
  };
  const exact = await computeBearingProfileBatch(body, undefined, {
    lookupPrecomputed: async () => null,
    lookupElevations: async (points) => points.map(() => ({ heightMeters: 100, source: "DEM5A" })),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-09-30T00:00:00.000Z",
  });
  exact.terrainProfileComplete = true;
  const bucket = new WriteBackR2();
  const originRoutes = [];
  const first = await callBatch(body, bucket, async (input) => {
    const url = new URL(String(input));
    originRoutes.push(url.pathname);
    if (url.pathname === "/v1/bearing-profile/precomputed") return Response.json({ error: "nf" }, { status: 404 });
    if (url.pathname === "/v1/bearing-profile/compute") return Response.json(exact);
    throw new Error(`unexpected: ${url.pathname}`);
  });
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(bucket.puts.length, 1, "a complete E-drive result is written back once");
  assert.match(bucket.puts[0], /^edrive-bearing-profile-v1\/[0-9a-f]{64}\.json$/);

  // PC停止（Eドライブへの問い合わせは全て失敗）。R2の書き戻し分で返る。
  const second = await callBatch(body, bucket, async (input) => {
    throw new TypeError(`E-drive is offline: ${String(input)}`);
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(bucket.puts.length, 1);

  // 要求方位の集合が異なる要求とは共有しない（部分集合の取り違え防止）。
  const other = await callBatch({ ...body, bearings: [0, 90] }, bucket, async () => {
    throw new TypeError("E-drive is offline");
  });
  assert.equal(other.status, 503);
  const expanded = await fetchBearingProfileBatch(body, undefined, async () =>
    new Response(JSON.stringify(firstJson), { headers: { "Content-Type": "application/json" } })
  );
  assert.equal(expanded.profiles.length, 3, "the written-back payload passes full client validation");
});

test("registered spots are never overwritten by an E-drive write-back", async () => {
  const { PRECOMPUTED_BEARING_PROFILE_TARGETS } = await import("../../src/data/precomputedBearingProfileTargets.ts");
  const target = PRECOMPUTED_BEARING_PROFILE_TARGETS.find((entry) => entry.name === "東京スカイツリー");
  const body = {
    ...request,
    subjectPoint: { latitude: target.latitude, longitude: target.longitude, height: 12 },
    bearings: [0],
    maxDistanceMeters: 1_000,
  };
  const exact = await computeBearingProfileBatch(body, undefined, {
    lookupPrecomputed: async () => null,
    lookupElevations: async (points) => points.map(() => ({ heightMeters: 100, source: "DEM5A" })),
    lookupGeoidHeights: async (points) => points.map(() => 38),
    nowIso: () => "2026-09-30T00:00:00.000Z",
  });
  exact.terrainProfileComplete = true;
  const bucket = new WriteBackR2();
  const response = await callBatch(body, bucket, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/bearing-profile/precomputed") return Response.json({ error: "nf" }, { status: 404 });
    return Response.json(exact);
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(bucket.puts.length, 0);
});

test("503 from R2/E-drive is a reasoned miss, not a download-ending error", async () => {
  const { fetchBearingProfileBatchDetailed } = await import("../../src/cache/bearingProfileBatchClient.ts");
  for (const code of ["PRECOMPUTED_PROFILE_UNAVAILABLE", "PROFILE_SOURCE_UNAVAILABLE"]) {
    const outcome = await fetchBearingProfileBatchDetailed(request, undefined, async () =>
      Response.json({ code, error: `理由:${code}` }, { status: 503 })
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.miss.reason, `理由:${code}`);
  }
});
