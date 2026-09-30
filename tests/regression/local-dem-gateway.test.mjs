import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  configureServerRuntime,
  runWithServerRuntime,
  serverLocalDemGateway,
} from "../../server/cloudflareRuntime.ts";
import { computeBearingProfileBatch } from "../../server/bearingProfileBatch.ts";
import { lookupGsiElevations } from "../../server/gsiElevation.ts";
import {
  computeLocalBearingProfile,
  lookupLocalDemGatewayAuto,
  lookupLocalDemGatewayForSource,
  resetLocalDemGatewayForTests,
} from "../../server/localDemGateway.ts";
import {
  createRegisteredLocalDemEndpoint,
  encodeRegisteredLocalDemEndpoint,
  LOCAL_DEM_ENDPOINT_TTL_SECONDS,
} from "../../server/localDemEndpointRegistry.ts";

const gatewayConfiguration = {
  endpoint: "https://dem-origin.example.test/v1/elevation/batch",
  originToken: "origin-token-for-tests-00000000000000000000",
  accessClientId: "client-id-for-tests.access",
  accessClientSecret: "client-secret-for-tests-000000000000000000000000",
};
const originalFetch = globalThis.fetch;

function request(index = 0) {
  return {
    index,
    latitude: 35.6812,
    longitude: 139.7671,
    interpolation: "bilinear",
    interpolationMode: "neutral",
  };
}

function autoRequest(index = 0) {
  return {
    index,
    latitude: 35.6812,
    longitude: 139.7671,
    maximumDetail: "1m",
    interpolationMode: "neutral",
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureServerRuntime({});
  resetLocalDemGatewayForTests();
});

test("gateway sends fixed authentication headers and validates aligned results", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), gatewayConfiguration.endpoint);
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-astrosight-origin-token"), gatewayConfiguration.originToken);
    assert.equal(headers.get("cf-access-client-id"), gatewayConfiguration.accessClientId);
    assert.equal(headers.get("cf-access-client-secret"), gatewayConfiguration.accessClientSecret);
    const body = JSON.parse(init.body);
    assert.equal(body.source, "DEM10B");
    assert.deepEqual(body.points, [request(7), request(9)]);
    return Response.json({
      source: "DEM10B",
      results: [
        { index: 7, heightMeters: null },
        { index: 9, heightMeters: 44.25 },
      ],
      resolvedCount: 1,
    });
  };

  const result = await lookupLocalDemGatewayForSource(
    "DEM10B",
    [request(7), request(9)]
  );
  assert.equal(calls, 1);
  assert.deepEqual([...result], [[9, 44.25]]);
});

test("named gateway is disabled when the Access credential pair is incomplete", async () => {
  configureServerRuntime({
    localDemGateway: { ...gatewayConfiguration, accessClientSecret: undefined },
  });
  globalThis.fetch = async () => {
    throw new Error("disabled gateway must not issue a request");
  };
  assert.equal((await lookupLocalDemGatewayForSource("DEM10B", [request()])).size, 0);
});

test("domainless gateway resolves a short-lived Quick Tunnel URL without Access headers", async () => {
  const registered = createRegisteredLocalDemEndpoint(
    "https://quiet-river-123.trycloudflare.com"
  );
  assert.ok(registered);
  let registryReads = 0;
  configureServerRuntime({
    localDemGateway: {
      originToken: gatewayConfiguration.originToken,
      endpointRegistry: {
        async get(key, options) {
          registryReads += 1;
          assert.equal(key, "local-dem-origin/v1/active");
          assert.deepEqual(options, { type: "arrayBuffer" });
          return encodeRegisteredLocalDemEndpoint(registered);
        },
      },
    },
  });
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(
      String(input),
      "https://quiet-river-123.trycloudflare.com/v1/elevation/batch"
    );
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-astrosight-origin-token"), gatewayConfiguration.originToken);
    assert.equal(headers.get("cf-access-client-id"), null);
    assert.equal(headers.get("cf-access-client-secret"), null);
    return Response.json({
      source: "DEM10B",
      results: [{ index: 0, heightMeters: 21.75 }],
      resolvedCount: 1,
    });
  };

  const result = await lookupLocalDemGatewayForSource("DEM10B", [request()]);
  assert.equal(registryReads, 1);
  assert.equal(calls, 1);
  assert.equal(result.get(0), 21.75);
});

test("expired Quick Tunnel registration is ignored without making a request", async () => {
  const expired = createRegisteredLocalDemEndpoint(
    "https://expired-origin.trycloudflare.com",
    Date.now() - LOCAL_DEM_ENDPOINT_TTL_SECONDS * 1_000 - 1
  );
  assert.ok(expired);
  configureServerRuntime({
    localDemGateway: {
      originToken: gatewayConfiguration.originToken,
      endpointRegistry: {
        async get() {
          return encodeRegisteredLocalDemEndpoint(expired);
        },
      },
    },
  });
  globalThis.fetch = async () => {
    throw new Error("expired registration must not issue a request");
  };
  assert.equal((await lookupLocalDemGatewayForSource("DEM10B", [request()])).size, 0);
});

test("invalid origin responses fail open to the existing elevation path", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      source: "DEM10B",
      results: [{ index: 0, heightMeters: 99_999 }],
    });
  };
  assert.equal((await lookupLocalDemGatewayForSource("DEM10B", [request()])).size, 0);
  assert.equal((await lookupLocalDemGatewayForSource("DEM10B", [request()])).size, 0);
  assert.equal(calls, 1, "a failing origin is suppressed briefly instead of delaying every tier");
});

test("the E-drive origin resolves the same precision tier before public GSI", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  globalThis.fetch = async (input, init) => {
    if (String(input) !== gatewayConfiguration.endpoint) {
      throw new Error("public GSI must not run after an E-drive hit");
    }
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(init.redirect, "manual");
    assert.equal(body.mode, "auto");
    return Response.json({
      mode: "auto",
      complete: true,
      results: [{ index: 0, heightMeters: 31.75, source: "DEM10B" }],
    });
  };
  const [sample] = await lookupGsiElevations([{
    latitude: 35.6812,
    longitude: 139.7671,
    maximumDetail: "10m",
    interpolationMode: "neutral",
  }]);
  assert.deepEqual(sample, { heightMeters: 31.75, source: "DEM10B" });
});

test("automatic gateway chunks large lookups and preserves authoritative NoData", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  const calls = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init.redirect, "manual");
    const body = JSON.parse(init.body);
    calls.push(body.points.length);
    return Response.json({
      mode: "auto",
      complete: true,
      results: body.points.map((point) => ({
        index: point.index,
        heightMeters: point.index === 1024 ? null : point.index * 0.01,
        source: point.index === 1024 ? null : "DEM5A",
      })),
    });
  };
  const result = await lookupLocalDemGatewayAuto(
    Array.from({ length: 1025 }, (_, index) => autoRequest(index))
  );
  assert.deepEqual(calls, [512, 512, 1]);
  assert.equal(result.size, 1025);
  assert.deepEqual(result.get(1024), { heightMeters: null, source: null });
  assert.deepEqual(result.get(25), { heightMeters: 0.25, source: "DEM5A" });
});

test("32 bearings at 50 km remain below the free Worker external subrequest limit", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.mode, "auto");
    assert.ok(body.points.length <= 512);
    return Response.json({
      mode: "auto",
      complete: true,
      results: body.points.map((point) => ({
        index: point.index,
        heightMeters: 100,
        source: "DEM10B",
      })),
    });
  };
  const response = await computeBearingProfileBatch({
    subjectPoint: { latitude: 35.710063, longitude: 139.8107, height: 0 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: Array.from({ length: 32 }, (_, index) => index),
    maxDistanceMeters: 50_000,
  });
  assert.equal(response.profiles.length, 32);
  assert.equal(response.failedBearings.length, 0);
  // One precomputed-profile probe plus forty 512-point elevation chunks. The
  // miss still leaves nine requests of margin below the Free-plan limit.
  assert.equal(calls, 41);
  assert.ok(calls < 50);
});

test("a real-size 259-bearing precomputed response stays on the one-request path", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  const bearings = Array.from({ length: 259 }, (_, index) => index);
  const distancesMeters = Array.from({ length: 352 }, (_, index) =>
    index === 351 ? 10_000 : 8 + index * 28
  );
  const responseBody = {
    version: 2,
    precomputed: true,
    distancesMeters,
    profiles: bearings.map((bearingDegrees) => ({
      bearingDegrees,
      computedAtIso: "2026-09-29T00:00:00.000Z",
      ellipsoidalHeightsMeters: distancesMeters.map(() => 123.1234567890123),
      elevationSources: distancesMeters.map(() => "DEM10B"),
    })),
    failedBearings: [],
    requestedBearingCount: bearings.length,
    pointCount: bearings.length * distancesMeters.length,
  };
  const encoded = JSON.stringify(responseBody);
  assert.ok(Buffer.byteLength(encoded) > 2 * 1024 * 1024, "fixture must cover the former 2 MiB rejection");
  assert.ok(Buffer.byteLength(encoded) < 8 * 1024 * 1024);
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://dem-origin.example.test/v1/bearing-profile/precomputed");
    assert.equal(init.redirect, "manual");
    return new Response(encoded, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) },
    });
  };

  const response = await computeBearingProfileBatch({
    subjectPoint: { latitude: 35.7100627, longitude: 139.8107004, height: 634 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings,
    maxDistanceMeters: 10_000,
  });
  assert.equal(calls, 1);
  assert.equal(response.precomputed, true);
  assert.equal(response.profiles.length, 259);
  assert.equal(response.pointCount, 91_168);
  assert.equal(response.failedBearings.length, 0);
});

test("an arbitrary coordinate uses one authenticated exact-profile origin request", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  const exactRequest = {
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0, 1],
    maxDistanceMeters: 10_000,
  };
  const responseBody = {
    version: 2,
    terrainProfileComplete: true,
    distancesMeters: [8, 10_000],
    profiles: exactRequest.bearings.map((bearingDegrees) => ({
      bearingDegrees,
      ellipsoidalHeightsMeters: [101, 102],
      elevationSources: ["DEM1A", "DEM10B"],
      computedAtIso: "2026-09-30T00:00:00.000Z",
    })),
    failedBearings: [],
    requestedBearingCount: 2,
    pointCount: 4,
  };
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://dem-origin.example.test/v1/bearing-profile/compute");
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-astrosight-origin-token"), gatewayConfiguration.originToken);
    assert.equal(headers.get("cf-access-client-id"), gatewayConfiguration.accessClientId);
    assert.equal(headers.get("cf-access-client-secret"), gatewayConfiguration.accessClientSecret);
    assert.deepEqual(JSON.parse(init.body), exactRequest);
    return Response.json(responseBody);
  };
  assert.deepEqual(await computeLocalBearingProfile(exactRequest), responseBody);
  assert.equal(calls, 1);
});

test("exact-profile origin rejects partial data and opens its short circuit", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  const exactRequest = {
    subjectPoint: { latitude: 35.7101127, longitude: 139.8107504, height: 12 },
    cameraSettings: { lensCenterHeightMeters: 1.6 },
    bearings: [0],
    maxDistanceMeters: 10_000,
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      version: 2,
      terrainProfileComplete: true,
      distancesMeters: [8, 10_000],
      profiles: [],
      failedBearings: [{ bearingDegrees: 0, reason: "missing" }],
      requestedBearingCount: 1,
      pointCount: 2,
    });
  };
  assert.equal(await computeLocalBearingProfile(exactRequest), null);
  assert.equal(await computeLocalBearingProfile(exactRequest), null);
  assert.equal(calls, 1, "the failed origin is not hammered during the cooldown");
});

test("caller cancellation is propagated instead of converted into a fallback", async () => {
  configureServerRuntime({ localDemGateway: gatewayConfiguration });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    lookupLocalDemGatewayForSource("DEM10B", [request()], controller.signal),
    (error) => error?.name === "AbortError"
  );
});

test("concurrent requests keep their DEM credentials isolated", async () => {
  const first = { ...gatewayConfiguration, endpoint: "https://first.example.test/v1/elevation/batch" };
  const second = { ...gatewayConfiguration, endpoint: "https://second.example.test/v1/elevation/batch" };
  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });

  const firstTask = runWithServerRuntime({ localDemGateway: first }, async () => {
    await firstPaused;
    await Promise.resolve();
    return serverLocalDemGateway();
  });
  const secondTask = runWithServerRuntime({ localDemGateway: second }, async () => {
    const visible = serverLocalDemGateway();
    releaseFirst();
    await Promise.resolve();
    return visible;
  });

  const [firstVisible, secondVisible] = await Promise.all([firstTask, secondTask]);
  assert.deepEqual(firstVisible, first);
  assert.deepEqual(secondVisible, second);
  assert.equal(serverLocalDemGateway(), undefined, "request credentials must not leak to the default context");
});

// 2026-09-30: 方針変更。ライブ操作（purpose: "interactive"）もEドライブを使う。
// 優先順位は全経路で R2 → Eドライブ → 国土地理院。
test("a live interactive request through the Pages handler reaches the E-drive origin", async () => {
  const { onRequest } = await import("../../functions/api/gsi-elevation.ts");
  const originCalls = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) !== gatewayConfiguration.endpoint) {
      throw new Error(`public GSI must not run after an E-drive hit: ${String(input)}`);
    }
    const body = JSON.parse(init.body);
    originCalls.push(body.mode);
    return Response.json({
      mode: "auto",
      complete: true,
      results: body.points.map((point) => ({ index: point.index, heightMeters: 12.5, source: "DEM10B" })),
    });
  };
  const response = await onRequest({
    request: new Request("https://astrosight.pages.dev/api/gsi-elevation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "interactive",
        points: [{ latitude: 35.71, longitude: 139.81, maximumDetail: "10m", interpolationMode: "neutral" }],
      }),
    }),
    env: {
      LOCAL_DEM_API_URL: gatewayConfiguration.endpoint,
      LOCAL_DEM_ORIGIN_TOKEN: gatewayConfiguration.originToken,
      LOCAL_DEM_ACCESS_CLIENT_ID: gatewayConfiguration.accessClientId,
      LOCAL_DEM_ACCESS_CLIENT_SECRET: gatewayConfiguration.accessClientSecret,
    },
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.samples, [{ heightMeters: 12.5, source: "DEM10B" }]);
  assert.deepEqual(originCalls, ["auto"], "interactive traffic must use the E-drive origin");
});
