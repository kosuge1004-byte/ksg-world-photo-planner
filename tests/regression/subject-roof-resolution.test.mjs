import assert from "node:assert/strict";
import test from "node:test";

import {
  selectSubjectSurfacePoint,
  SubjectRoofResolutionError,
} from "../../src/height/subjectSurfaceResolution.ts";
import {
  resolveSpotLocation,
  subjectSurfaceHintForSpotLocation,
} from "../../src/search/spotPresetSearch.ts";
import {
  addSubjectHistory,
  loadSubjectHistory,
} from "../../src/subjectStorage.ts";
import {
  listDownloadedSpotData,
  renameDownloadedSpotData,
  upsertDownloadedSpotData,
} from "../../src/cache/downloadedSpotData.ts";
import { resolveJapanesePlaceName } from "../../server/placeGeocode.ts";
import {
  decodeProjectShareCode,
  encodeProjectShareCode,
} from "../../src/sharing/projectShareCode.ts";

function point(height, overrides = {}) {
  return {
    latitude: 35.6585805,
    longitude: 139.7454329,
    height,
    ellipsoidalHeightMeters: height,
    orthometricHeightMeters: height - 40,
    geoidHeightMeters: 40,
    heightSource: "dem",
    label: "東京タワー",
    ...overrides,
  };
}

test("known building never resolves to ground when live roof sources fail", () => {
  const ground = point(40);
  const resolved = selectSubjectSurfacePoint({
    groundPoint: ground,
    roofPoint: null,
    osmPoint: null,
    requireStructureRoof: true,
    knownStructureHeightMeters: 333,
    label: "東京タワー",
  });
  assert.equal(resolved.height, 373);
  assert.equal(resolved.orthometricHeightMeters, 333);
  assert.equal(resolved.heightSource, "catalogued-structure-height");
  assert.equal(resolved.subjectSurfaceTarget, "structure-roof");
  assert.notEqual(resolved.height, ground.height);
});

test("building without any valid roof evidence fails instead of returning DEM ground", () => {
  const ground = point(40);
  assert.throws(
    () => selectSubjectSurfacePoint({
      groundPoint: ground,
      roofPoint: point(40, { heightSource: "3d-picked" }),
      osmPoint: null,
      requireStructureRoof: true,
      label: "高さ未登録の建物",
    }),
    SubjectRoofResolutionError
  );
});

test("already resolved roof is not given the structure height a second time", () => {
  const ground = point(40);
  const roof = point(373, {
    heightSource: "3d-picked",
    subjectSurfaceTarget: "structure-roof",
  });
  const resolved = selectSubjectSurfacePoint({
    groundPoint: ground,
    roofPoint: roof,
    osmPoint: null,
    requireStructureRoof: true,
    knownStructureHeightMeters: 333,
    label: "東京タワー",
  });
  assert.equal(resolved.height, 373);
  assert.notEqual(resolved.height, 706);
});

test("static landmark roof classification and height survive history round trip", async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };

  const location = await resolveSpotLocation("東京タワー");
  assert.equal(location.subjectSurfaceTarget, "structure-roof");
  assert.equal(location.structureHeightMeters, 333);

  const resolved = selectSubjectSurfacePoint({
    groundPoint: point(40, { label: location.label }),
    roofPoint: null,
    osmPoint: null,
    requireStructureRoof: true,
    knownStructureHeightMeters: location.structureHeightMeters,
    label: location.label,
  });
  addSubjectHistory(resolved, "place");
  const restored = loadSubjectHistory()[0];
  assert.equal(restored.subjectSurfaceTarget, "structure-roof");
  assert.equal(restored.structureHeightMeters, 333);
  assert.equal(restored.height, 373);

  // 修正前に保存されたメタデータ無し履歴も、静的座標と名称から復元する。
  const legacyHint = subjectSurfaceHintForSpotLocation({
    latitude: location.latitude,
    longitude: location.longitude,
    label: location.label,
  });
  assert.deepEqual(legacyHint, {
    requireStructureRoof: true,
    knownStructureHeightMeters: 333,
  });
});

test("castles, temples and ferris wheels are also classified as roof subjects", async () => {
  for (const name of ["岐阜城", "高野山 金剛峯寺", "コスモクロック21"]) {
    const location = await resolveSpotLocation(name);
    assert.equal(
      location.subjectSurfaceTarget,
      "structure-roof",
      `${name} must require a structure top`
    );
    assert.equal(
      subjectSurfaceHintForSpotLocation(location).requireStructureRoof,
      true,
      `${name} metadata must survive the resolution boundary`
    );
  }
});

test("Nominatim structural POIs retain roof requirement and mapped height", async () => {
  const resolved = await resolveJapanesePlaceName("検査城", undefined, async (input) => {
    const url = String(input);
    if (url.startsWith("https://nominatim.openstreetmap.org/")) {
      assert.match(url, /[?&]extratags=1(?:&|$)/u);
      return Response.json([{
        lat: "35.1",
        lon: "139.1",
        display_name: "検査城, 検査市",
        name: "検査城",
        category: "historic",
        type: "castle",
        extratags: { height: "42 m" },
        importance: 0.8,
      }]);
    }
    return Response.json([]);
  });
  assert.equal(resolved.subjectSurfaceTarget, "structure-roof");
  assert.equal(resolved.structureHeightMeters, 42);
});

test("downloaded spot rename keeps roof classification for saved-record revalidation", () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  upsertDownloadedSpotData({
    subjectId: "35.658581,139.745433",
    label: "東京タワー",
    latitude: 35.6585805,
    longitude: 139.7454329,
    downloadedAtIso: "2026-09-28T00:00:00.000Z",
    status: "complete",
    profilePoints: 10,
    highPrecisionPoints: 20,
    subjectSurfaceTarget: "structure-roof",
    structureHeightMeters: 333,
  });
  renameDownloadedSpotData("35.658581,139.745433", "お気に入りの場所");
  const restored = listDownloadedSpotData()[0];
  assert.equal(restored.label, "お気に入りの場所");
  assert.equal(restored.subjectSurfaceTarget, "structure-roof");
  assert.equal(restored.structureHeightMeters, 333);
  assert.deepEqual(subjectSurfaceHintForSpotLocation(restored), {
    requireStructureRoof: true,
    knownStructureHeightMeters: 333,
  });
});

test("project share round trip keeps roof intent without serializing absolute altitude", () => {
  const code = encodeProjectShareCode({
    name: "屋上検査",
    shootingDateTimeLocal: "2026-09-28T12:00",
    timeZone: "Asia/Tokyo",
    subject: {
      latitude: 35.6585805,
      longitude: 139.7454329,
      label: "東京タワー",
      subjectSurfaceTarget: "structure-roof",
      structureHeightMeters: 333,
    },
    tripod: { latitude: 35.66, longitude: 139.74, label: "三脚" },
    foregroundObjects: [],
    cameraSettings: {
      focalLengthMm: 50,
      lensCenterHeightMeters: 1.5,
    },
    celestialVisibility: { sun: true, moon: false, milkyWay: false, polaris: false },
    previewFrameMode: "screen",
  });
  const decoded = decodeProjectShareCode(code);
  assert.equal(decoded.subject.subjectSurfaceTarget, "structure-roof");
  assert.equal(decoded.subject.structureHeightMeters, 333);
  assert.equal("height" in decoded.subject, false);
});
