import assert from "node:assert/strict";
import test from "node:test";

const points = Array.from({ length: 3_000 }, (_, index) => ({
  latitude: 35 + index * 0.00001,
  longitude: 136 + index * 0.00002,
}));
let capturedQuery = "";
let capturedMethod = "";
let capturedBody;

globalThis.fetch = async (input, init = {}) => {
  capturedMethod = init.method ?? "GET";
  capturedBody = init.body;
  capturedQuery = capturedMethod === "GET"
    ? new URL(String(input)).searchParams.get("data") ?? ""
    : new URLSearchParams(init.body).get("data") ?? "";
  return new Response(JSON.stringify({
    elements: [{
      type: "way",
      id: 1,
      tags: { natural: "water", water: "river" },
      geometry: [
        { lat: 34.99999, lon: 135.99999 },
        { lat: 34.99999, lon: 136.00001 },
        { lat: 35.00001, lon: 136.00001 },
        { lat: 35.00001, lon: 135.99999 },
        { lat: 34.99999, lon: 135.99999 },
      ],
    }],
  }), { headers: { "Content-Type": "application/json" } });
};

const { lookupOsmSiteContexts } = await import("../../server/osmSiteContext.ts");
const { calculateKarneySurfaceMetrics } = await import("../../src/geodesy/karneyGeodesic.ts");

test("water-only covers every point's 120m neighborhood with four compact circle filters", async () => {
  const contexts = await lookupOsmSiteContexts(points, undefined, false, "water-only");
  assert.equal(capturedMethod, "GET");
  assert.equal(capturedBody, undefined);
  const matches = [...capturedQuery.matchAll(/\(around:(\d+),(-?[\d.]+),(-?[\d.]+)\)/g)];
  assert.equal(matches.length, 4);
  assert.ok(matches.every((match) => match[0] === matches[0][0]));
  const radiusMeters = Number(matches[0][1]);
  const center = { latitude: Number(matches[0][2]), longitude: Number(matches[0][3]) };
  assert.ok(points.every((point) =>
    calculateKarneySurfaceMetrics(center, point).distanceMeters + 120 <= radiusMeters
  ));
  assert.ok(capturedQuery.length < 1_000, "the query must not grow with all 3,000 coordinates");
  assert.equal(capturedQuery.match(/\["natural"="water"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["water"="river"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["water"="canal"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["waterway"="riverbank"\]/g)?.length, 1);
  assert.equal(contexts.length, points.length);
});

test("larger full site-context queries remain POST requests", async () => {
  await lookupOsmSiteContexts([points[0]], undefined, true, "full");
  assert.equal(capturedMethod, "POST");
  assert.ok(capturedBody instanceof URLSearchParams);
});

test("water-only rejects input above the API boundary before querying Overpass", async () => {
  await assert.rejects(
    lookupOsmSiteContexts([...points, { latitude: 36, longitude: 137 }], undefined, false, "water-only"),
    /1〜3000/
  );
});

test("a shared candidate set is still classified independently for every point", async () => {
  const contexts = await lookupOsmSiteContexts(points, undefined, false, "water-only");
  assert.equal(contexts[0].onWaterSurface, true);
  assert.equal(contexts[0].waterSurfaceKind, "river");
  assert.ok(contexts.slice(1).every((context) =>
    context.onWaterSurface === false && context.waterSurfaceKind === "none"
  ));
});
