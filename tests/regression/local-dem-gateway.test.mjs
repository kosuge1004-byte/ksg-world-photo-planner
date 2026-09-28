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
  lookupLocalDemGatewayAuto,
  lookupLocalDemGatewayForSource,
  resetLocalDemGatewayForTests,
} from "../../server/localDemGateway.ts";

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

test("gateway is disabled unless URL and all three credentials are configured", async () => {
  configureServerRuntime({
    localDemGateway: { ...gatewayConfiguration, accessClientSecret: undefined },
  });
  globalThis.fetch = async () => {
    throw new Error("disabled gateway must not issue a request");
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
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "https://dem-origin.example.test/v1/bearing-profile/precomputed");
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
