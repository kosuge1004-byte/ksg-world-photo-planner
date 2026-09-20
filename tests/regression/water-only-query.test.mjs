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
  if (String(input).includes("cyberjapandata.gsi.go.jp")) {
    return new Response(null, { status: 404 });
  }
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

test("a local full site-context query uses a cacheable GET", async () => {
  const contexts = await lookupOsmSiteContexts([points[0]], undefined, true, "full");
  assert.equal(capturedMethod, "GET");
  assert.equal(capturedBody, undefined);
  assert.equal(contexts.length, 1);
});

test("eight nearby points use two bounded boxes without losing either search radius", async () => {
  const nearbyPoints = Array.from({ length: 8 }, (_, index) => ({
    latitude: 35 + Math.cos(index * Math.PI / 4) * 0.0003,
    longitude: 136 + Math.sin(index * Math.PI / 4) * 0.0003,
  }));
  await lookupOsmSiteContexts(nearbyPoints, undefined, true, "full");
  assert.equal(capturedMethod, "GET");
  assert.equal(capturedQuery.match(/\["highway"\]/g)?.length, 1);
  assert.equal(capturedQuery.match(/\["building"\]\["wikidata"\]/g)?.length, 1);
  const boxes = [...capturedQuery.matchAll(
    /(?:way|nwr)\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/g
  )].map((match) => ({
    south: Number(match[1]),
    west: Number(match[2]),
    north: Number(match[3]),
    east: Number(match[4]),
  }));
  const uniqueBoxes = [...new Map(boxes.map((box) => [
    `${box.south},${box.west},${box.north},${box.east}`,
    box,
  ])).values()];
  assert.equal(uniqueBoxes.length, 2);
  const landmarkBox = uniqueBoxes.reduce((largest, box) =>
    box.north - box.south > largest.north - largest.south ? box : largest
  );
  for (const point of nearbyPoints) {
    const latitudeDelta = 600 / 110_000;
    const longitudeDelta = 600 /
      (110_000 * Math.abs(Math.cos(point.latitude * Math.PI / 180)));
    assert.ok(landmarkBox.south <= point.latitude - latitudeDelta);
    assert.ok(landmarkBox.north >= point.latitude + latitudeDelta);
    assert.ok(landmarkBox.west <= point.longitude - longitudeDelta);
    assert.ok(landmarkBox.east >= point.longitude + longitudeDelta);
  }
});

test("spatially separated points keep bounded per-point circles and use POST", async () => {
  const separatedPoints = Array.from({ length: 8 }, (_, index) => ({
    latitude: 35,
    longitude: 136 + index * 0.1,
  }));
  await lookupOsmSiteContexts(separatedPoints, undefined, true, "full");
  assert.equal(capturedMethod, "POST");
  assert.ok(capturedBody instanceof URLSearchParams);
  const circles = [...capturedQuery.matchAll(
    /\(around:(\d+),(-?[\d.]+),(-?[\d.]+)\)/g
  )];
  assert.ok(circles.length > 0);
  assert.deepEqual(
    [...new Set(circles.map((match) => Number(match[1])))].sort((a, b) => a - b),
    [120, 600]
  );
  for (const point of separatedPoints) {
    assert.ok(capturedQuery.includes(`(around:120,${point.latitude},${point.longitude})`));
    assert.ok(capturedQuery.includes(`(around:600,${point.latitude},${point.longitude})`));
  }
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
