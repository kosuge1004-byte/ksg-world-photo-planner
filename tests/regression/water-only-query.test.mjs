import assert from "node:assert/strict";
import test from "node:test";

const points = Array.from({ length: 80 }, (_, index) => ({
  latitude: 35 + index * 0.00001,
  longitude: 136 + index * 0.00002,
}));
const expectedCoordinates = points.flatMap((point) => [point.latitude, point.longitude]).join(",");
let capturedQuery = "";

globalThis.fetch = async (_input, init) => {
  capturedQuery = new URLSearchParams(init.body).get("data") ?? "";
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

test("water-only sends all 80 vertices through four compact around-linestring filters", async () => {
  const contexts = await lookupOsmSiteContexts(points, undefined, false, "water-only");
  const around = `(around:120,${expectedCoordinates})`;
  assert.equal(capturedQuery.split(around).length - 1, 4);
  assert.equal(capturedQuery.match(/\(around:120,/g)?.length, 4);
  assert.equal(capturedQuery.match(/\["natural"="water"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["water"="river"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["water"="canal"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["waterway"="riverbank"\]/g)?.length, 1);
  assert.equal(contexts.length, points.length);
});

test("a shared candidate set is still classified independently for every point", async () => {
  const contexts = await lookupOsmSiteContexts(points, undefined, false, "water-only");
  assert.equal(contexts[0].onWaterSurface, true);
  assert.equal(contexts[0].waterSurfaceKind, "river");
  assert.ok(contexts.slice(1).every((context) =>
    context.onWaterSurface === false && context.waterSurfaceKind === "none"
  ));
});
