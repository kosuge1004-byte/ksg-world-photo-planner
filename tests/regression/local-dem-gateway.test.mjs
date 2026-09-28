import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  configureServerRuntime,
  runWithServerRuntime,
  serverLocalDemGateway,
} from "../../server/cloudflareRuntime.ts";
import { lookupGsiElevations } from "../../server/gsiElevation.ts";
import {
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
  globalThis.fetch = async (input) => {
    if (String(input) !== gatewayConfiguration.endpoint) {
      throw new Error("public GSI must not run after an E-drive hit");
    }
    return Response.json({
      source: "DEM10B",
      results: [{ index: 0, heightMeters: 31.75 }],
      resolvedCount: 1,
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
