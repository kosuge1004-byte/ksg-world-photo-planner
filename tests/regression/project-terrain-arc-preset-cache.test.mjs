import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;

const {
  createProjectTerrainArcSnapshot,
  deleteProjectTerrainArcSnapshot,
  loadProjectTerrainArcSnapshot,
  projectTerrainArcContextKey,
  restoreProjectTerrainArcs,
  saveProjectTerrainArcSnapshot,
} = await import("../../src/cache/projectTerrainArcCache.ts");

const subject = {
  latitude: 35.681236,
  longitude: 139.767125,
  height: 42.5,
  ellipsoidalHeightMeters: 42.5,
  orthometricHeightMeters: 3.1,
  geoidHeightMeters: 39.4,
  subjectSurfaceTarget: "structure-roof",
  structureHeightMeters: 20,
  label: "テスト建物",
};

function context(overrides = {}) {
  return {
    subject,
    dayStart: new Date("2026-11-15T00:00:00+09:00"),
    dayEnd: new Date("2026-11-15T23:59:59.999+09:00"),
    lensCenterHeightMeters: 1.6,
    calculationMode: "pro",
    maxDistanceMeters: 10_000,
    revision: "complete:126720:2026-11-15T01:00:00.000Z",
    passKey: "sun:day,moon:day,milkyWay:day",
    ...overrides,
  };
}

function point(timestampMilliseconds, latitude, longitude, distanceMeters) {
  return {
    id: "moon",
    label: "月",
    latitude,
    longitude,
    height: 12,
    distanceMeters,
    solutionType: "preliminary",
    timestampMilliseconds,
  };
}

function exactArc() {
  const first = point(Date.parse("2026-11-15T09:00:00Z"), 35.68, 139.76, 900);
  const second = point(Date.parse("2026-11-15T09:02:00Z"), 35.679, 139.759, 1_050);
  return {
    id: "moon",
    riseAt: new Date("2026-11-15T08:00:00Z"),
    setAt: new Date("2026-11-15T20:00:00Z"),
    points: [first, second],
    segments: [[first, second]],
    kind: "terrain",
    // 大きい再計算用modelは保存しないことも確認する。
    model: { shouldNotPersist: true },
  };
}

test("プリセットの確定線は日時と計算条件が同じ場合だけ復元される", () => {
  const key = projectTerrainArcContextKey(context());
  const snapshot = createProjectTerrainArcSnapshot(key, [exactArc()]);
  assert.ok(snapshot);
  assert.equal(JSON.stringify(snapshot).includes("shouldNotPersist"), false);

  const restored = restoreProjectTerrainArcs(snapshot, key);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].kind, "terrain");
  assert.ok(restored[0].riseAt instanceof Date);
  assert.ok(restored[0].setAt instanceof Date);
  assert.equal(restored[0].points.length, 2);
  assert.equal(restored[0].model, undefined);

  const differentLensKey = projectTerrainArcContextKey(context({ lensCenterHeightMeters: 1.7 }));
  assert.deepEqual(restoreProjectTerrainArcs(snapshot, differentLensKey), []);
});

test("平坦地形の目安線は確定線として保存しない", () => {
  const flat = { ...exactArc(), kind: "flat" };
  assert.equal(createProjectTerrainArcSnapshot(projectTerrainArcContextKey(context()), [flat]), null);
});

test("単独の地形交点をプリセットに保存しても線は作らない", () => {
  const key = projectTerrainArcContextKey(context());
  const arc = exactArc();
  const points = [arc.points[0]];
  const snapshot = createProjectTerrainArcSnapshot(key, [{ ...arc, points, segments: [points] }]);
  assert.ok(snapshot);
  assert.deepEqual(restoreProjectTerrainArcs(snapshot, key)[0].segments, [points]);
});

test("確定線はIndexedDBでプリセットIDごとに永続化・削除できる", async () => {
  const projectId = "preset-terrain-line-test";
  const key = projectTerrainArcContextKey(context());
  const snapshot = createProjectTerrainArcSnapshot(key, [exactArc()]);
  assert.ok(snapshot);
  await saveProjectTerrainArcSnapshot(projectId, snapshot);
  const loaded = await loadProjectTerrainArcSnapshot(projectId);
  assert.ok(loaded);
  assert.equal(restoreProjectTerrainArcs(loaded, key).length, 1);

  await deleteProjectTerrainArcSnapshot(projectId);
  assert.equal(await loadProjectTerrainArcSnapshot(projectId), null);
});

test("プリセットの保存・読込・削除と確定線キャッシュが接続されている", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /commitProjectSave[\s\S]*createProjectTerrainArcSnapshot[\s\S]*saveProjectTerrainArcSnapshot/);
  assert.match(app, /loadPlannerProject[\s\S]*loadProjectTerrainArcSnapshot[\s\S]*setSubjectPoint/);
  assert.match(app, /restoreProjectTerrainArcs[\s\S]*terrainArcResultRef\.current = restored/);
  assert.match(app, /removePlannerProject[\s\S]*deleteProjectTerrainArcSnapshot/);
});
