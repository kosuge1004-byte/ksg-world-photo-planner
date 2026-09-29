import assert from "node:assert/strict";
import test from "node:test";

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};

const {
  anchorToRegisteredCoordinates,
  provisionalRegisteredStructurePoint,
  readLearnedStructureHeight,
  rememberStructureHeight,
  resolveRegisteredStructureWithoutLiveHeight,
} = await import("../../src/height/registeredStructureHeight.ts");
const { registeredLandmarkAtExactPoint } = await import("../../src/search/spotPresetSearch.ts");
const { PRECOMPUTED_BEARING_PROFILE_TARGETS } = await import("../../server/precomputedBearingProfileTargets.ts");

const { JAPAN_LANDMARKS } = await import("../../src/data/japanLandmarks.ts");
const himeji = JAPAN_LANDMARKS.find((l) => l.name === "姫路城");
const anchor = { name: himeji.name, latitude: himeji.latitude, longitude: himeji.longitude };
const ground = {
  latitude: himeji.latitude, longitude: himeji.longitude, height: 85, ellipsoidalHeightMeters: 85,
  orthometricHeightMeters: 46, geoidHeightMeters: 39, heightSource: "dem", label: "姫路城",
};

test("every precomputed R2 target is found at its exact client catalogue coordinates", () => {
  for (const landmark of PRECOMPUTED_BEARING_PROFILE_TARGETS) {
    assert.ok(registeredLandmarkAtExactPoint(landmark.latitude, landmark.longitude),
      `${landmark.name} is missing from the client catalogue at its seed coordinates`);
  }
});

test("roof peak found tens of metres away keeps its height but not its horizontal offset", () => {
  const roof = {
    latitude: himeji.latitude + 0.0003, longitude: himeji.longitude - 0.0002,
    height: 131, ellipsoidalHeightMeters: 131, orthometricHeightMeters: 92.01, geoidHeightMeters: 38.99,
    heightSource: "3d-picked", subjectSurfaceTarget: "structure-roof", label: "姫路城",
  };
  const anchored = anchorToRegisteredCoordinates(roof, ground);
  assert.equal(anchored.latitude, himeji.latitude);
  assert.equal(anchored.longitude, himeji.longitude);
  assert.equal(anchored.ellipsoidalHeightMeters, 131);
  assert.equal(anchored.orthometricHeightMeters, 92);
  assert.equal(anchored.subjectSurfaceTarget, "structure-roof");
});

test("without live or learned height a registered structure is placed provisionally, not rejected", () => {
  const point = resolveRegisteredStructureWithoutLiveHeight(anchor, ground, "姫路城");
  assert.equal(point.subjectHeightProvisional, true);
  assert.equal(point.latitude, himeji.latitude);
  assert.equal(point.ellipsoidalHeightMeters, 85);
});

test("a resolved structure height is learned and reused; implausible heights are ignored", () => {
  assert.equal(readLearnedStructureHeight(anchor), null);
  rememberStructureHeight(anchor, ground, { ...ground, height: 131, ellipsoidalHeightMeters: 131, heightSource: "3d-picked" });
  assert.equal(readLearnedStructureHeight(anchor), 46);
  const other = { ...anchor, name: "別地点" };
  rememberStructureHeight(other, ground, { ...ground, height: 85.5, ellipsoidalHeightMeters: 85.5 });
  assert.equal(readLearnedStructureHeight(other), null);
});

test("provisional placement stays on registered coordinates and forces re-resolution later", () => {
  const provisional = provisionalRegisteredStructurePoint({ ...ground, subjectSurfaceTarget: "structure-roof" });
  assert.equal(provisional.latitude, himeji.latitude);
  assert.equal(provisional.subjectHeightProvisional, true);
  assert.equal(provisional.subjectSurfaceTarget, undefined);
});

test("a learned height is used when PLATEAU/OSM are unavailable later", () => {
  const point = resolveRegisteredStructureWithoutLiveHeight(anchor, ground, "姫路城");
  assert.equal(point.subjectHeightProvisional, undefined);
  assert.equal(point.heightSource, "learned-structure-height");
  assert.equal(point.subjectSurfaceTarget, "structure-roof");
  assert.equal(point.ellipsoidalHeightMeters, 131);
  assert.equal(point.latitude, himeji.latitude);
});
