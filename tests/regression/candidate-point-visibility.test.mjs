import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlateauLineOfSightPath,
  findPlateauLineOfSightBlocker,
  japaneseThirdMeshCode,
} from "../../tools/local-dem-server/plateauLineOfSight.ts";
import {
  isCandidatePointVisibilityRequest,
  isCandidatePointVisibilityResponse,
} from "../../src/types/candidatePointVisibility.ts";
import { searchCandidatePointVisibility } from "../../src/visibility/candidatePointVisibility.ts";

const candidate = { latitude: 35, longitude: 139 };
const subject = { latitude: 35, longitude: 139.01 };

function rectangle(south, west, north, east, height) {
  return [[
    south, west, height,
    south, east, height,
    north, east, height,
    north, west, height,
    south, west, height,
  ]];
}

function building(id, west, east, top = 110) {
  return {
    dataset: "plateau-test",
    buildingId: id,
    bbox: [34.99995, west, 35.00005, east],
    geometry: {
      minimumHeightMeters: 90,
      maximumHeightMeters: top,
      topFaces: [rectangle(34.99995, west, 35.00005, east, top)],
    },
  };
}

test("PLATEAU line-of-sight blocks an intersecting building and excludes only the exact subject id", () => {
  const path = buildPlateauLineOfSightPath(candidate, subject, 25);
  const target = building("subject-building", 139.0098, 139.01, 130);
  const neighbour = building("neighbour-building", 139.0049, 139.0051, 125);
  const targetKey = new Set(["plateau-test\u0000subject-building"]);

  const blocker = findPlateauLineOfSightBlocker(path, 101.6, 130, [target, neighbour], targetKey);
  assert.ok(blocker);
  assert.equal(blocker.buildingId, "neighbour-building");
  assert.ok(blocker.distanceFromCandidateMeters > 400);
  assert.ok(blocker.distanceFromCandidateMeters < 600);

  const onlyTarget = findPlateauLineOfSightBlocker(path, 101.6, 130, [target], targetKey);
  assert.equal(onlyTarget, null, "the subject itself is excluded by exact dataset + building id");

  const wrongId = findPlateauLineOfSightBlocker(
    path, 101.6, 130, [target], new Set(["plateau-test\u0000other-building"])
  );
  assert.ok(wrongId, "a nearby/wrong id must not create a broad exclusion area");
});

test("PLATEAU line-of-sight leaves a building below the ray clear", () => {
  const path = buildPlateauLineOfSightPath(candidate, subject, 25);
  const low = building("low-building", 139.0049, 139.0051, 95);
  assert.equal(findPlateauLineOfSightBlocker(path, 101.6, 130, [low], new Set()), null);
});

test("third mesh conversion matches a real PLATEAU manifest mesh", () => {
  assert.equal(japaneseThirdMeshCode(42.8989, 141.3300), "64412276");
});

test("candidate visibility API contracts reject unknown fields and accept complete responses", () => {
  const request = {
    subject: { latitude: 35, longitude: 139, orthometricHeightMeters: 100 },
    lensCenterHeightMeters: 1.6,
    points: [{
      key: "moon:1000",
      celestialId: "moon",
      timestampMilliseconds: 1000,
      latitude: 35,
      longitude: 139.01,
    }],
  };
  assert.equal(isCandidatePointVisibilityRequest(request), true);
  assert.equal(isCandidatePointVisibilityRequest({ ...request, path: "E:\\secret" }), false);
  assert.equal(isCandidatePointVisibilityResponse({
    results: [{ key: "moon:1000", status: "clear" }],
    excludedSubjectBuilding: null,
  }, new Set(["moon:1000"])), true);
  assert.equal(isCandidatePointVisibilityResponse({
    results: [{ key: "moon:other", status: "clear" }],
    excludedSubjectBuilding: null,
  }, new Set(["moon:1000"])), false);
});

test("only fully verified clear points are returned; building-unverified points are hidden", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      results: request.points.map((point, index) => ({
        key: point.key,
        status: index === 0 ? "clear" : index === 1 ? "blocked" : "unverified",
      })),
      excludedSubjectBuilding: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const points = [0, 1, 2].map((index) => ({
    id: "moon",
    label: `月 ${index}`,
    latitude: 35,
    longitude: 139 + index * 0.001,
    height: 10,
    distanceMeters: 100 + index,
    timestampMilliseconds: 1000 + index,
    lineOfSightPossiblyObstructed: false,
  }));
  try {
    const result = await searchCandidatePointVisibility({
      subject: {
        latitude: 35,
        longitude: 139.01,
        height: 100,
        orthometricHeightMeters: 100,
        label: "被写体",
      },
      lensCenterHeightMeters: 1.6,
      arcs: [{
        id: "moon",
        riseAt: new Date(1000),
        setAt: new Date(2000),
        kind: "terrain",
        points,
      }],
    });
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0].timestampMilliseconds, 1000);
    assert.equal(result.buildingBlockedCount, 1);
    assert.equal(result.buildingUnverifiedCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
