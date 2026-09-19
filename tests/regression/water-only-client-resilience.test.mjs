import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.window ??= { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

const contextFor = (point) => ({
  walkingAccessible: false,
  onMappedWay: false,
  restrictedAccess: false,
  onMotorRoad: false,
  onWaterSurface: point.latitude % 2 > 1,
  waterSurfaceKind: point.latitude % 2 > 1 ? "river" : "none",
  nearbyLandmarks: [{ name: String(point.latitude), type: "tower", distanceMeters: 0 }],
  nearbyBuildings: [],
  nearbyStructures: [],
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

const { fetchSiteContexts } = await import("../../src/search/siteContext.ts");

test("normal water downloads split more than 500 points without changing their order", async () => {
  const points = Array.from({ length: 1_001 }, (_, index) => ({
    latitude: 30 + index * 0.001,
    longitude: 130 + index * 0.001,
  }));
  const requestSizes = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init.body);
    requestSizes.push(request.points.length);
    return json({ contexts: request.points.map(contextFor) });
  };

  const contexts = await fetchSiteContexts(points, undefined, false, "water-only");
  assert.deepEqual(requestSizes, [500, 500, 1]);
  assert.deepEqual(contexts, points.map(contextFor), "batch responses must retain the original point order");

  requestSizes.length = 0;
  assert.deepEqual(
    await fetchSiteContexts(points, undefined, false, "water-only"),
    contexts,
    "every successful batch must be immediately reusable from IndexedDB"
  );
  assert.deepEqual(requestSizes, []);
});

test("a failed 500-point water request splits into ordered 250-point halves and caches both", async () => {
  const points = Array.from({ length: 500 }, (_, index) => ({
    latitude: 32 + index * 0.001,
    longitude: 132 + index * 0.001,
  }));
  const requestSizes = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init.body);
    requestSizes.push(request.points.length);
    if (request.points.length === 500) return json({ error: "temporary overload" }, 422);
    return json({ contexts: request.points.map(contextFor) });
  };

  const contexts = await fetchSiteContexts(points, undefined, false, "water-only");
  assert.deepEqual(requestSizes, [500, 250, 250]);
  assert.deepEqual(contexts, points.map(contextFor));
  requestSizes.length = 0;
  assert.deepEqual(await fetchSiteContexts(points, undefined, false, "water-only"), contexts);
  assert.deepEqual(requestSizes, []);
});

test("successful siblings remain cached when one single-point water request cannot recover", async () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    latitude: 40 + index * 0.001,
    longitude: 140 + index * 0.001,
  }));
  const badLatitude = points.at(-1).latitude;
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init.body);
    requests.push(request.points.map((point) => point.latitude));
    if (request.points.some((point) => point.latitude === badLatitude)) {
      return json({ error: "unrecoverable point" }, 422);
    }
    return json({ contexts: request.points.map(contextFor) });
  };

  await assert.rejects(
    fetchSiteContexts(points, undefined, false, "water-only"),
    /unrecoverable point/
  );
  const callsBeforeCachedRead = requests.length;
  const successfulLeftHalf = points.slice(0, 4);
  assert.deepEqual(
    await fetchSiteContexts(successfulLeftHalf, undefined, false, "water-only"),
    successfulLeftHalf.map(contextFor)
  );
  assert.equal(requests.length, callsBeforeCachedRead, "successful work before the terminal failure must persist");
});

test("an explicit parent abort does not split or retry a water request", async () => {
  const points = Array.from({ length: 80 }, (_, index) => ({
    latitude: 45 + index * 0.00001,
    longitude: 145 + index * 0.00001,
  }));
  const controller = new AbortController();
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    controller.abort();
    throw init.signal.reason;
  };
  await assert.rejects(fetchSiteContexts(points, controller.signal, false, "water-only"));
  assert.equal(requestCount, 1);
});
