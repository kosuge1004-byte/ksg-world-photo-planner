import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRiseSetArcTimeline,
  buildTripodCandidateRiseSetArc,
  prioritizedRiseSetCandidateBodyIds,
  riseSetArcSegments,
} from "../../src/cesium/tripodCandidateRiseSetArc.ts";
import {
  alignTerrainArcToExactCandidate,
  buildTerrainRiseSetArc,
  farthestTripodCandidatesByBody,
  requiredTerrainBearings,
  terrainIntersectionForSample,
  terrainSectionBearing,
} from "../../src/cesium/tripodCandidateTerrainArc.ts";
import {
  buildCelestialBackwardRay,
  rayCartographicAtDistance,
} from "../../src/cesium/tripodCandidates.ts";
import { calculateKarneyLineMetrics } from "../../src/geodesy/karneyGeodesic.ts";
import { fetchStaticPrecomputedTerrainProfile } from "../../src/cache/bearingProfileBatchClient.ts";
import {
  loadTerrainSectionLookup,
  resetTerrainSectionMemoryForTests,
  terrainSectionSourcesFor,
} from "../../src/cache/tripodTerrainSections.ts";
import { PRECOMPUTED_BEARING_PROFILE_TARGETS } from "../../src/data/precomputedBearingProfileTargets.ts";

const LENS = 1.5;
const MAX = 10_000;
const GROUND = 55;
// 地表（楕円体高55m）から約330m上の塔の先端。
const subject = {
  latitude: 35.6586, longitude: 139.7454, height: 388,
  ellipsoidalHeightMeters: 388, orthometricHeightMeters: 351, geoidHeightMeters: 37, label: "塔",
};
const day = {
  id: "sun",
  subject,
  dayStart: new Date("2026-10-07T15:00:00.000Z"), // 2026-10-08 00:00 JST
  dayEnd: new Date("2026-10-08T15:00:00.000Z"),
  lensCenterHeightMeters: LENS,
  calculationMode: "standard",
  maxDistanceMeters: MAX,
};

// 地表距離8m〜10.5kmを25m刻みで並べた断面（実データは30m以内の刻み）。
const DISTANCES = Array.from({ length: 421 }, (_, index) => 8 + index * 25);
const section = (heightAt) => ({
  distancesMeters: DISTANCES,
  ellipsoidalHeightsMeters: DISTANCES.map((distance) => heightAt(distance)),
});
const groundDistance = (point) =>
  calculateKarneyLineMetrics({ ...subject, height: 0 }, { ...point, height: 0, label: "" }).distanceMeters;

test("rise/set terrain lines prioritize the displayed body and then process one body at a time", () => {
  assert.deepEqual(prioritizedRiseSetCandidateBodyIds("moon"), ["moon", "sun", "milkyWay"]);
  assert.deepEqual(prioritizedRiseSetCandidateBodyIds("milkyWay"), ["milkyWay", "sun", "moon"]);
  assert.deepEqual(prioritizedRiseSetCandidateBodyIds(null), []);
});

test("the selected exact candidate is the single displayed point and lies on the terrain line", async () => {
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /alignTerrainArcToExactCandidate\([\s\S]*?exactCandidates\.get\(id\),[\s\S]*?selectedDate\.getTime\(\)/);
  assert.match(app, /farthestTripodCandidatesByBody\(tripodCandidates\)/);
  const candidates = farthestTripodCandidatesByBody([
    { id: "moon", label: "月", latitude: 35, longitude: 136, height: 10, distanceMeters: 100 },
    { id: "moon", label: "月", latitude: 35.1, longitude: 136.1, height: 20, distanceMeters: 300 },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].distanceMeters, 300);
  const timeline = buildRiseSetArcTimeline({ ...day, sampleMinutes: 2 });
  const terrain = await buildTerrainRiseSetArc(timeline, () => section(() => GROUND), { yieldEverySamples: 0 });
  const target = terrain.points[Math.floor(terrain.points.length / 2)];
  const exact = { ...target, latitude: target.latitude + 0.0001, longitude: target.longitude - 0.0001 };
  const aligned = alignTerrainArcToExactCandidate(terrain, exact, target.timestampMilliseconds);
  const replaced = aligned.points.find((point) => point.timestampMilliseconds === target.timestampMilliseconds);
  assert.equal(replaced.latitude, exact.latitude);
  assert.equal(replaced.longitude, exact.longitude);
  // 目安の線の高さ基準は被写体ごとに固定し、三脚ピンの移動では決め直さない。
  assert.match(app, /frozenArcReferenceRef\.current\?\.key === subjectGroundKey/);
  const flat = buildTripodCandidateRiseSetArc({ ...day, referenceGroundEllipsoidalHeightMeters: [GROUND] });
  assert.equal(flat.kind, "flat");
  assert.equal(riseSetArcSegments(flat).length, 1);
});

test("on perfectly level ground the terrain line coincides with the level-ground guide", async () => {
  const flat = buildTripodCandidateRiseSetArc({ ...day, referenceGroundEllipsoidalHeightMeters: [GROUND] });
  const timeline = buildRiseSetArcTimeline(day);
  const terrain = await buildTerrainRiseSetArc(timeline, () => section(() => GROUND), { yieldEverySamples: 0 });
  assert.ok(terrain);
  assert.equal(terrain.kind, "terrain");
  assert.equal(terrain.segments.length, 1, "level ground has no break");
  const flatByTime = new Map(flat.points.map((point) => [point.timestampMilliseconds, point]));
  let compared = 0;
  for (const point of terrain.points) {
    const expected = flatByTime.get(point.timestampMilliseconds);
    if (!expected || expected.distanceMeters >= MAX || point.distanceMeters >= MAX) continue;
    compared += 1;
    // 厳密な楕円体計算（目安の線）と、断面の線形補間（25m刻み）の差は1m未満。
    assert.ok(Math.abs(point.distanceMeters - expected.distanceMeters) < 1,
      `distance ${point.distanceMeters} vs ${expected.distanceMeters}`);
    assert.ok(groundDistance(point) > 0 && Math.abs(point.height - GROUND) < 1e-6);
    assert.ok(Math.abs(point.latitude - expected.latitude) < 1e-5);
    assert.ok(Math.abs(point.longitude - expected.longitude) < 1e-5);
  }
  assert.ok(compared > 40, `compared ${compared}`);
});

test("each vertex is where the real sight line reaches lens height above the terrain of that bearing", async () => {
  // 方位と距離で高さが変わるなだらかな起伏（±25m）。
  const heightAt = (bearing, distance) => GROUND + 25 * Math.sin(distance / 1300 + bearing / 23);
  const timeline = buildRiseSetArcTimeline({ ...day, sampleMinutes: 2 });
  const terrain = await buildTerrainRiseSetArc(
    timeline, (bearing) => section((distance) => heightAt(bearing, distance)), { yieldEverySamples: 0 }
  );
  assert.ok(terrain);
  const sampleByTime = new Map(timeline.model.samples.map((sample) => [sample.timestampMilliseconds, sample]));
  let checked = 0;
  for (const point of terrain.points) {
    if (point.distanceMeters >= MAX) continue;
    const sample = sampleByTime.get(point.timestampMilliseconds);
    const ray = buildCelestialBackwardRay(
      subject, sample.azimuthDegrees, sample.rayAltitudeDegrees, timeline.model.observer
    );
    // 独立に検算: 厳密な楕円体計算で、頂点が実際の視線上にあり、その高さが
    // 「その方位の断面の地面 + レンズ高」に一致すること。
    const onRay = rayCartographicAtDistance(ray, point.distanceMeters);
    assert.ok(Math.abs(onRay.latitude * 180 / Math.PI - point.latitude) < 1e-9);
    assert.ok(Math.abs(onRay.longitude * 180 / Math.PI - point.longitude) < 1e-9);
    const ground = heightAt(terrainSectionBearing(sample.azimuthDegrees), groundDistance(point));
    assert.ok(Math.abs(onRay.height - LENS - ground) < 0.6,
      `ray ${onRay.height - LENS} vs ground ${ground} at ${point.distanceMeters}m`);
    assert.ok(Math.abs(point.height - ground) < 0.6);
    checked += 1;
  }
  assert.ok(checked > 200, `checked ${checked}`);
  // 平らと仮定した線とは実際に違う場所を通る（標高が効いている）。
  const flat = buildTripodCandidateRiseSetArc({ ...day, sampleMinutes: 2, referenceGroundEllipsoidalHeightMeters: [GROUND] });
  const flatByTime = new Map(flat.points.map((point) => [point.timestampMilliseconds, point]));
  const largest = Math.max(...terrain.points.map((point) => {
    const other = flatByTime.get(point.timestampMilliseconds);
    return other && other.distanceMeters < MAX && point.distanceMeters < MAX
      ? Math.abs(point.distanceMeters - other.distanceMeters) : 0;
  }));
  assert.ok(largest > 100, `largest difference ${largest}`);
});

test("with several intersections the farthest one is used, like the confirmed-candidate search", () => {
  const timeline = buildRiseSetArcTimeline(day);
  // 太陽高度が7〜9度の時刻（視線は約2.1〜2.7km先で高さ55mへ降りる）。
  const sample = timeline.model.samples.find((item) => item.rayAltitudeDegrees > 7 && item.rayAltitudeDegrees < 9);
  const level = terrainIntersectionForSample(timeline.model, sample, section(() => GROUND));
  assert.equal(level.type, "hit");
  // 手前1km〜1.2kmに高さ250mの尾根を置くと、視線は尾根に入り・抜け・最後に平地へ届く（交点3つ）。
  const ridge = section((distance) => distance >= 1000 && distance <= 1200 ? 250 : GROUND);
  const withRidge = terrainIntersectionForSample(timeline.model, sample, ridge);
  assert.equal(withRidge.type, "hit");
  assert.ok(Math.abs(withRidge.rayDistanceMeters - level.rayDistanceMeters) < 1, "farthest intersection");
  assert.ok(Math.abs(withRidge.groundEllipsoidalHeightMeters - GROUND) < 1e-6);
});

test("samples beyond the search range go to the limit circle only when the section covers the range", () => {
  const timeline = buildRiseSetArcTimeline(day);
  // 太陽高度1度前後: 高さ55mへ降りるのは約19km先（検索上限10kmより遠い）。
  const low = timeline.model.samples.find((item) => item.rayAltitudeDegrees > 0.6 && item.rayAltitudeDegrees < 1.4);
  assert.ok(low);
  assert.equal(terrainIntersectionForSample(timeline.model, low, section(() => GROUND)).type, "beyond");
  // 断面が5kmまでしか無ければ、その先に何があるか分からないので頂点を作らない。
  const short = {
    distancesMeters: DISTANCES.filter((distance) => distance <= 5000),
    ellipsoidalHeightsMeters: DISTANCES.filter((distance) => distance <= 5000).map(() => GROUND),
  };
  assert.equal(terrainIntersectionForSample(timeline.model, low, short).type, "none");
  // 被写体が地面より低い（視線が最初から地中）なら候補は無い。
  assert.equal(terrainIntersectionForSample(timeline.model, low, section(() => 500)).type, "none");
});

test("the line is cut where the intersection jumps to another slope, and kept whole on smooth ground", async () => {
  const timeline = buildRiseSetArcTimeline({ ...day, sampleMinutes: 2 });
  // 午後、太陽高度が8度前後の時刻の方位（平地なら交点は約2.4km先）。
  const afternoon = timeline.model.samples.filter((sample, index, all) =>
    index > all.length / 2 && sample.rayAltitudeDegrees > 7.5 && sample.rayAltitudeDegrees < 8.5
  );
  assert.ok(afternoon.length > 0);
  const middle = terrainSectionBearing(afternoon[0].azimuthDegrees);
  // その前後4度ぶんの方位だけ、1km先から高さ250mの台地が始まる。その方位では交点が
  // 台地（約1〜1.7km先）になり、隣の方位（平地・数km先）と不連続になる。
  const lookup = (bearing) => section((distance) => {
    const delta = Math.abs(((bearing - middle + 540) % 360) - 180);
    return delta <= 4 && distance >= 1000 ? 250 : GROUND;
  });
  const terrain = await buildTerrainRiseSetArc(timeline, lookup, { yieldEverySamples: 0 });
  assert.ok(terrain);
  const drawable = riseSetArcSegments(terrain);
  assert.ok(drawable.length >= 2, `segments ${drawable.length}`);
  // どの区間の中にも、平地（高さ55m）と台地（高さ250m）をまたぐ頂点の並びは無い。
  for (const segment of drawable) {
    const onPlateau = segment.filter((point) => point.distanceMeters < MAX).map((point) => point.height > 150);
    assert.ok(onPlateau.every((value) => value === onPlateau[0]), "segment mixes plateau and plain");
  }
  // 時刻順は保たれ、区間をつなげると全頂点になる。
  assert.deepEqual(terrain.segments.flat(), terrain.points);
  const times = terrain.points.map((point) => point.timestampMilliseconds);
  assert.deepEqual(times, [...times].sort((left, right) => left - right));

  // なだらかな傾斜（10kmで+60m）では切らない。
  const smooth = await buildTerrainRiseSetArc(
    timeline, () => section((distance) => GROUND + distance * 0.006), { yieldEverySamples: 0 }
  );
  assert.equal(riseSetArcSegments(smooth).length, 1);
});

test("a missing bearing section or an aborted run yields no terrain line", async () => {
  const timeline = buildRiseSetArcTimeline(day);
  const bearings = requiredTerrainBearings(timeline);
  assert.ok(bearings.length > 60 && bearings.every((bearing) => Number.isFinite(bearing) && bearing >= 0 && bearing < 360));
  assert.ok(bearings.some((bearing) => !Number.isInteger(bearing)));
  assert.equal(terrainSectionBearing(0.4), 180.4);
  assert.equal(terrainSectionBearing(179.6), 359.6);
  assert.equal(terrainSectionBearing(359.7), 179.7);
  const missingOne = (bearing) => bearing === bearings[5] ? null : section(() => GROUND);
  assert.equal(await buildTerrainRiseSetArc(timeline, missingOne, { yieldEverySamples: 0 }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await buildTerrainRiseSetArc(timeline, () => section(() => GROUND), { signal: controller.signal }), null);
  // 被写体が周囲の地面より低い場合は線にできる交点が無い。
  assert.equal(await buildTerrainRiseSetArc(timeline, () => section(() => 500), { yieldEverySamples: 0 }), null);
});

function precomputedFile(target, overrides = {}) {
  const distancesMeters = [8, 100, 1000, 5000, 10_000];
  return {
    schemaVersion: 1,
    format: "astrosight-precomputed-bearing-profile-v1",
    subject: { name: target.name, latitude: target.latitude, longitude: target.longitude },
    maxDistanceMeters: target.maxDistanceMeters,
    generatedAt: "2026-09-30T00:00:00.000Z",
    response: {
      version: 2,
      precomputed: true,
      distancesMeters,
      profiles: Array.from({ length: 360 }, (_, bearingDegrees) => ({
        bearingDegrees,
        ellipsoidalHeightsMeters: distancesMeters.map((distance) => 40 + bearingDegrees / 10 + distance / 1000),
        elevationSources: distancesMeters.map(() => "DEM5A"),
        computedAtIso: "2026-09-30T00:00:00.000Z",
      })),
      failedBearings: [],
      requestedBearingCount: 360,
      pointCount: 360 * distancesMeters.length,
    },
    ...overrides,
  };
}

test("built-in spots read the published file once, keep it in memory only, and retry after a failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; resetTerrainSectionMemoryForTests(); });
  resetTerrainSectionMemoryForTests();
  const target = PRECOMPUTED_BEARING_PROFILE_TARGETS.find((item) => item.maxDistanceMeters === 10_000);
  const builtIn = { latitude: target.latitude, longitude: target.longitude, height: 100, label: target.name };

  // 整数断面には従来の計算済みファイル、小数方位には全国DEMのexact経路がある。
  assert.deepEqual(terrainSectionSourcesFor(builtIn), ["precomputed", "exact"]);
  const arbitrary = { latitude: target.latitude + 0.0123, longitude: target.longitude, height: 100, label: "ピン" };
  assert.deepEqual(terrainSectionSourcesFor(arbitrary), ["exact"]);

  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.match(String(input), /\/precomputed-bearing-profile-v1\/[0-9a-f]+\.json\.gz$/u);
    return new Response(JSON.stringify(precomputedFile(target)), { status: 200 });
  };
  const loaded = await loadTerrainSectionLookup({
    subject: builtIn, lensCenterHeightMeters: LENS, maxDistanceMeters: MAX, bearings: [0, 90, 359], revision: "none",
  });
  assert.equal(loaded.source, "precomputed");
  assert.deepEqual(Array.from(loaded.lookup(90).distancesMeters), [8, 100, 1000, 5000, 10_000]);
  assert.equal(loaded.lookup(90).ellipsoidalHeightsMeters[2], 40 + 9 + 1);
  // 日付や天体を変えて別の方位が要るようになっても、同じファイルを取り直さない。
  const again = await loadTerrainSectionLookup({
    subject: builtIn, lensCenterHeightMeters: LENS, maxDistanceMeters: MAX, bearings: [10, 200], revision: "none",
  });
  assert.equal(again.source, "precomputed");
  assert.equal(calls, 1);
  // 未配置（404）はnull。失敗は覚えず、次回はもう一度試す。
  resetTerrainSectionMemoryForTests();
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("not found", { status: 404 }); };
  const request = { subject: builtIn, lensCenterHeightMeters: LENS, maxDistanceMeters: MAX, bearings: [0], revision: "none" };
  assert.equal(await loadTerrainSectionLookup(request), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await loadTerrainSectionLookup(request), null);
  // 各試行で静的ファイル→exact APIの順に試すため2回ずつ。
  assert.equal(calls, 4);
});

test("fractional bearings are fetched exactly in one batch and cached", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; resetTerrainSectionMemoryForTests(); });
  resetTerrainSectionMemoryForTests();
  const arbitrary = { latitude: 35.4, longitude: 136.7, height: 100, label: "任意地点" };
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.match(String(input), /\/api\/bearing-profile-batch$/u);
    const request = JSON.parse(init.body);
    assert.deepEqual(request.bearings, [12.345678, 98.765432]);
    const distances = [8, 1000, 10_000];
    return new Response(JSON.stringify({
      version: 1,
      terrainProfileComplete: true,
      profiles: request.bearings.map((bearingDegrees) => ({
        bearingDegrees,
        points: distances.map((distanceMeters) => ({
          distanceMeters,
          latitude: 35.4,
          longitude: 136.7,
          ellipsoidalHeightMeters: 50 + bearingDegrees / 100,
          elevationSource: "DEM5A",
        })),
        computedAtIso: "2026-10-20T00:00:00.000Z",
      })),
      failedBearings: [],
      requestedBearingCount: request.bearings.length,
      pointCount: request.bearings.length * distances.length,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const input = {
    subject: arbitrary,
    lensCenterHeightMeters: LENS,
    maxDistanceMeters: MAX,
    bearings: [12.345678, 98.765432],
    revision: "none",
  };
  const loaded = await loadTerrainSectionLookup(input);
  assert.equal(loaded.source, "exact");
  assert.equal(loaded.lookup(12.345678).ellipsoidalHeightsMeters.length, 3);
  const again = await loadTerrainSectionLookup(input);
  assert.equal(again.source, "exact");
  assert.equal(calls, 1);
});

test("a published file for another place, range or with broken heights is rejected", async () => {
  const target = PRECOMPUTED_BEARING_PROFILE_TARGETS.find((item) => item.maxDistanceMeters === 10_000);
  const request = {
    subjectPoint: { latitude: target.latitude, longitude: target.longitude, height: 0, label: target.name },
    maxDistanceMeters: target.maxDistanceMeters,
  };
  const respond = (file) => async () => new Response(JSON.stringify(file), { status: 200 });
  const good = await fetchStaticPrecomputedTerrainProfile(request, undefined, respond(precomputedFile(target)));
  assert.equal(good.heightsByBearing.size, 360);
  assert.equal(good.distancesMeters.length, 5);

  const elsewhere = precomputedFile(target, {
    subject: { name: "別地点", latitude: target.latitude + 0.001, longitude: target.longitude },
  });
  assert.equal(await fetchStaticPrecomputedTerrainProfile(request, undefined, respond(elsewhere)), null);
  assert.equal(await fetchStaticPrecomputedTerrainProfile(
    request, undefined, respond(precomputedFile(target, { maxDistanceMeters: 50_000 }))
  ), null);
  const broken = precomputedFile(target);
  broken.response.profiles[7].ellipsoidalHeightsMeters[1] = null;
  assert.equal(await fetchStaticPrecomputedTerrainProfile(request, undefined, respond(broken)), null);
  const unordered = precomputedFile(target);
  unordered.response.distancesMeters[2] = 50;
  assert.equal(await fetchStaticPrecomputedTerrainProfile(request, undefined, respond(unordered)), null);
  // SPAのindex.htmlが返った場合（ファイル未配置）。
  assert.equal(await fetchStaticPrecomputedTerrainProfile(
    request, undefined, async () => new Response("<!doctype html><html></html>", { status: 200 })
  ), null);
});

test("app wiring: exact terrain line, exact candidate anchor, and no rounded fallback", async () => {
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
  // 断面が得られる見込みが無い地点は、すぐ目安の線を出す。
  assert.match(app, /if \(!terrainArcRequest\.expectsTerrain\) return tripodCandidateRiseSetBaseArcs;/);
  // ダウンロードの完了・更新・削除で読み直す（＝自動で切り替わる）。
  assert.match(app, /terrainSectionRevision = useMemo\(\(\) => \{[\s\S]*?downloadedSpotData\.find/);
  assert.match(app, /revision: terrainSectionRevision,/);
  // 小数方位はまとめAPIから正確な断面を取得し、1度断面へフォールバックしない。
  const sections = await readFile(new URL("../../src/cache/tripodTerrainSections.ts", import.meta.url), "utf8");
  assert.match(sections, /fetchBearingProfileBatch\(/);
  assert.match(sections, /const sources = exactRequired[\s\S]*?\["exact"\]/);
  assert.match(app, /maxDistanceMeters: request\.maxDistanceMeters,[\s\S]*?bearings: requiredTerrainBearings/);
  assert.match(app, /const ids = prioritizedRiseSetCandidateBodyIds\(priorityId\);/);
  assert.match(app, /if \(arc\) arcs\[id\] = arc;[\s\S]*?completed\[id\] = true;[\s\S]*?publish\(\);/);
  assert.match(app, /id !== request\.priorityId &&[\s\S]*?tripodCandidateCalculationStatus === "calculating"/);
  assert.match(app, /terrainArcRequest\.ids\.flatMap\(\(id\) => \{\s*if \(!celestialVisibility\[id\]\) return \[\];/);
  assert.match(app, /function commitManuallyPlacedSubject[\s\S]*?lastConfirmedTripodCandidatesRef\.current = \[\];[\s\S]*?setTripodCandidates\(\[\]\);/);
  assert.equal((app.match(/commitManuallyPlacedSubject\(point\);/g) ?? []).length, 3);
  // ドラッグ中の仮の候補点は、地表に沿った距離で写す（直線距離をそのまま使わない）。
  assert.match(app, /groundDistanceMeters = calculateKarneyLineMetrics\([\s\S]*?\)\.distanceMeters;[\s\S]*?calculateKarneyDestinationPoint\([\s\S]*?groundDistanceMeters\s*\)/);
  // 区間ごとに描き、標高を加味した線は実線・目安の線は破線。
  assert.match(map2d, /riseSetArcSegments\(arc\)/);
  assert.match(map2d, /"map-tripod-rise-set-arc terrain"/);
  assert.match(css, /\.map-tripod-rise-set-arc\.terrain\s*\{[\s\S]*?stroke-dasharray:\s*none;/);
  assert.match(entities, /riseSetArcSegments\(arc\)/);
  assert.match(entities, /arc\.kind === "terrain"\s*\?\s*new ColorMaterialProperty/);
});
