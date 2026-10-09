// 2026-10-09: 自由ビューモード（被写体を使わない独立した全画面3D）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Cartesian3, Matrix4, Transforms } from "cesium";

import * as celestial from "../../src/cesium/celestial.ts";
import { createCameraModel, createFreeViewCameraModel } from "../../src/cesium/cameraModelFactory.ts";
import {
  clampFreeViewFocalLengthMm,
  freeViewCameraModel,
  freeViewFocalLengthAfterPinch,
  freeViewPoseAfterDrag,
  normalizeFreeViewHeadingDegrees,
} from "../../src/cesium/freeViewCamera.ts";
import {
  freeViewCelestialFrame,
  freeViewDayRange,
  freeViewTrackSampleMinutes,
  freeViewTrackSamples,
} from "../../src/freeView/freeViewCelestial.ts";
import {
  createLatestOnlyGuard,
  parseFreeViewCoordinateQuery,
  resolveFreeViewDirectLocation,
  resolveFreeViewObserverGround,
} from "../../src/search/freeViewObserverSearch.ts";
import { projectToScreen, horizontalDirectionToVec3 } from "../../src/projection/projectionService.ts";
import { sensorDimensionsMm } from "../../src/cesium/optics.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const ground = (latitude, longitude, orthometric = 1000, geoid = 40, label = "視点") => ({
  latitude, longitude, height: orthometric + geoid, ellipsoidalHeightMeters: orthometric + geoid,
  orthometricHeightMeters: orthometric, geoidHeightMeters: geoid, heightSource: "dem", label,
});
const observer = ground(35.3606, 138.7274);

// 自由ビュー追加前の基準版（AstroSight-audit-fixes-20261009）で同じ入力から求めた値の要約。
// 既存の公開関数（プレビュー・軌跡・天の川・カメラモデル）の出力が1桁も変わっていないことを確認する。
const BASELINE_DIGESTS = {"24/1.5/standard:model":"913c3799daafac2d","24/1.5/standard:points":"8f26547b30f744d5","24/1.5/standard:tracks":"b08ffe605da7078e","24/1.5/standard:milky":"0faf3d8e22c3ce8b","200/0.5625/pro:model":"0489243fb9c1d98c","200/0.5625/pro:points":"33e3294f9fa73db8","200/0.5625/pro:tracks":"68a420dde0920322","200/0.5625/pro:milky":"19be84e87614f8d7","1600/2.2/standard:model":"054a49b36b050adf","1600/2.2/standard:points":"5e126f03ef1b226a","1600/2.2/standard:tracks":"ff5d1f7dc47792c3","1600/2.2/standard:milky":"a98072a567fdceb4","9/0.45/pro:model":"3601980deccb242b","9/0.45/pro:points":"08c85e8167fbd9f4","9/0.45/pro:tracks":"0cdac23be92a5a63","9/0.45/pro:milky":"567d0817acc8d2eb"};

test("FV-16: existing camera model / celestial points / tracks / milky way output is unchanged from the baseline", () => {
  const tripod = { latitude: 35.3606, longitude: 138.7274, height: 1040, ellipsoidalHeightMeters: 1040, orthometricHeightMeters: 1000, geoidHeightMeters: 40, heightSource: "dem", label: "t" };
  const subject = { latitude: 35.3628, longitude: 138.7310, height: 1240, ellipsoidalHeightMeters: 1240, orthometricHeightMeters: 1200, geoidHeightMeters: 40, heightSource: "dem", label: "s" };
  const round = (v) => JSON.parse(JSON.stringify(v, (k, x) => typeof x === "number" ? Number(x.toPrecision(12)) : x));
  const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
  const digestOf = (value) => createHash("sha256").update(JSON.stringify(sortKeys(round(value)))).digest("hex").slice(0, 16);
  const plain = (m) => ({ ...m, observerEcef: { ...m.observerEcef }, ecefForward: { ...m.ecefForward }, ecefRight: { ...m.ecefRight }, ecefUp: { ...m.ecefUp } });
  let checked = 0;
  for (const [focal, aspect, mode] of [[24, 1.5, "standard"], [200, 0.5625, "pro"], [1600, 2.2, "standard"], [9, 0.45, "pro"]]) {
    const settings = { focalLengthMm: focal, lensCenterHeightMeters: 1.5 };
    const corr = { azimuthDegrees: 1.25, altitudeDegrees: -0.5 };
    const date = new Date("2026-10-20T10:30:00Z");
    const key = `${focal}/${aspect}/${mode}`;
    const pair = createCameraModel(tripod, subject, settings, aspect, mode, corr);
    const actual = {
      model: { g: plain(pair.geometry), a: plain(pair.apparent) },
      points: celestial.calculateCelestialScreenPoints(date, tripod, subject, settings, aspect, mode, corr),
      tracks: celestial.calculateCelestialScreenTracks(tripod, subject, settings, aspect, mode, new Date("2026-10-19T03:00:00Z"), new Date("2026-10-21T03:00:00Z"), "Asia/Tokyo", corr),
      milky: celestial.calculateMilkyWayScreenPath(date, tripod, subject, settings, aspect, mode, corr, 5),
    };
    for (const [name, value] of Object.entries(actual)) {
      assert.equal(digestOf(value), BASELINE_DIGESTS[`${key}:${name}`], `${key}:${name}`);
      checked += 1;
    }
  }
  assert.equal(checked, 16);
});

test("FV-05/06: heading cycles 0-90-180-270-360 with the true-north convention and the eye never moves", () => {
  const enuToEcef = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(observer.longitude, observer.latitude, 1041.5)
  );
  const toEcef = (east, north, up) =>
    Matrix4.multiplyByPointAsVector(enuToEcef, new Cartesian3(east, north, up), new Cartesian3());
  const first = createFreeViewCameraModel(observer, 0, 0, 1.5, 24, 0.5);
  // 視点 = 地表の楕円体高 + レンズ中心高（WGS84）。
  const expectedEye = Cartesian3.fromDegrees(observer.longitude, observer.latitude, 1040 + 1.5);
  assert.ok(Cartesian3.distance(first.observerEcef, expectedEye) < 1e-6);
  // 天体計算用の観測点は標高（正高）＋レンズ中心高。
  assert.equal(first.observerPoint.orthometricHeightMeters, 1001.5);

  const expectations = [[0, 0, 1], [90, 1, 0], [180, 0, -1], [270, -1, 0], [360, 0, 1]];
  for (const [heading, east, north] of expectations) {
    const model = createFreeViewCameraModel(observer, heading, 0, 1.5, 24, 0.5);
    assert.ok(Math.abs(model.localForward.east - east) < 1e-12 && Math.abs(model.localForward.north - north) < 1e-12, `heading ${heading}`);
    assert.ok(Math.abs(model.localForward.up) < 1e-12);
    // ECEFの向きは、その地点のENU（Cesiumの東・北・上）で同じ方向。
    assert.ok(Cartesian3.distance(model.ecefForward, toEcef(east, north, 0)) < 1e-9, `ecef ${heading}`);
    // 位置は1mmも動かない（同じ入力から同じECEF）。
    assert.equal(Cartesian3.distance(model.observerEcef, first.observerEcef), 0);
    assert.equal(model.rollRadians, 0);
    assert.ok(model.azimuthDegrees >= 0 && model.azimuthDegrees < 360);
  }
  assert.equal(normalizeFreeViewHeadingDegrees(360), 0);
  assert.equal(normalizeFreeViewHeadingDegrees(-90), 270);
  assert.equal(normalizeFreeViewHeadingDegrees(725), 5);

  // 仰角: 上が正。+30度で上向き、-30度で下向き。どの向き・画角でも位置は不変。
  for (const [pitch, focal, aspect] of [[30, 9, 0.45], [-30, 200, 1.5], [89, 1600, 2.2], [-89, 24, 0.5625]]) {
    const model = createFreeViewCameraModel(observer, 123.4, pitch, 1.5, focal, aspect);
    assert.ok(Math.abs(model.localForward.up - Math.sin(pitch * Math.PI / 180)) < 1e-12);
    assert.equal(Cartesian3.distance(model.observerEcef, first.observerEcef), 0);
    // right / up / forward は正規直交。
    const dot = (a, b) => a.east * b.east + a.north * b.north + a.up * b.up;
    assert.ok(Math.abs(dot(model.localForward, model.localRight)) < 1e-12);
    assert.ok(Math.abs(dot(model.localForward, model.localUp)) < 1e-12);
    assert.ok(Math.abs(dot(model.localRight, model.localUp)) < 1e-12);
    assert.ok(Math.abs(model.localRight.up) < 1e-12, "roll = 0（水平線が傾かない）");
  }
  // 範囲外の仰角は受け付けない（検証で止まる）。
  assert.throws(() => createFreeViewCameraModel(observer, 0, 91, 1.5, 24, 1));
});

test("FV-10: field of view follows the existing 36x24mm inscribed model for 9/24/200/1600mm and any aspect ratio", () => {
  for (const focal of [9, 24, 200, 1600]) {
    for (const aspect of [0.45, 0.5625, 1, 1.5, 2.2]) {
      const model = createFreeViewCameraModel(observer, 10, 5, 1.5, focal, aspect);
      const sensor = sensorDimensionsMm(aspect);
      assert.ok(Math.abs(model.horizontalFovDegrees - 2 * Math.atan(sensor.width / (2 * focal)) * 180 / Math.PI) < 1e-12);
      assert.ok(Math.abs(model.verticalFovDegrees - 2 * Math.atan(sensor.height / (2 * focal)) * 180 / Math.PI) < 1e-12);
      // 被写体ありの既存モデルと同じ画角（同じ焦点距離・同じアスペクト比）。
      const withSubject = createCameraModel(observer, ground(35.37, 138.74, 1200), { focalLengthMm: focal, lensCenterHeightMeters: 1.5 }, aspect, "standard").geometry;
      assert.equal(model.horizontalFovDegrees, withSubject.horizontalFovDegrees);
      assert.equal(model.verticalFovDegrees, withSubject.verticalFovDegrees);
      // 投影: 視線の中心は画面中央、水平画角の端は画面の左右端。
      const basis = { right: { x: model.localRight.east, y: model.localRight.north, z: model.localRight.up }, up: { x: model.localUp.east, y: model.localUp.north, z: model.localUp.up }, forward: { x: model.localForward.east, y: model.localForward.north, z: model.localForward.up }, horizontalFovDegrees: model.horizontalFovDegrees, verticalFovDegrees: model.verticalFovDegrees };
      const center = projectToScreen(horizontalDirectionToVec3(10, 5), basis);
      assert.ok(Math.abs(center.xPercent - 50) < 1e-9 && Math.abs(center.yPercent - 50) < 1e-9);
    }
  }
  const level = createFreeViewCameraModel(observer, 90, 0, 1.5, 24, 1.5);
  const basis = { right: { x: level.localRight.east, y: level.localRight.north, z: level.localRight.up }, up: { x: level.localUp.east, y: level.localUp.north, z: level.localUp.up }, forward: { x: level.localForward.east, y: level.localForward.north, z: level.localForward.up }, horizontalFovDegrees: level.horizontalFovDegrees, verticalFovDegrees: level.verticalFovDegrees };
  const rightEdge = projectToScreen(horizontalDirectionToVec3(90 + level.horizontalFovDegrees / 2, 0), basis);
  assert.ok(Math.abs(rightEdge.xPercent - 100) < 1e-9 && Math.abs(rightEdge.yPercent - 50) < 1e-9);
  const topEdge = projectToScreen(horizontalDirectionToVec3(90, level.verticalFovDegrees / 2), basis);
  assert.ok(Math.abs(topEdge.yPercent - 0) < 1e-9, "上向きが画面の上");
  const behind = projectToScreen(horizontalDirectionToVec3(270, 0), basis);
  assert.equal(behind.inFront, false);
});

test("FV-06: drag changes only heading/pitch, pinch changes only focal length", () => {
  const viewport = { widthPixels: 400, heightPixels: 800 };
  const fov = { horizontalFovDegrees: 40, verticalFovDegrees: 70 };
  const start = { headingDegrees: 350, pitchDegrees: 0 };
  // 指を左へ画面幅ぶん動かす → 視線は水平画角ぶん右へ（方位が増える）。360度をまたいで循環する。
  assert.deepEqual(freeViewPoseAfterDrag(start, -400, 0, viewport, fov), { headingDegrees: 30, pitchDegrees: 0 });
  assert.deepEqual(freeViewPoseAfterDrag(start, 400, 0, viewport, fov), { headingDegrees: 310, pitchDegrees: 0 });
  // 指を下へ → 上を向く。上下限で止まる。
  assert.equal(freeViewPoseAfterDrag(start, 0, 400, viewport, fov).pitchDegrees, 35);
  assert.equal(freeViewPoseAfterDrag(start, 0, 4000, viewport, fov).pitchDegrees, 89);
  assert.equal(freeViewPoseAfterDrag(start, 0, -4000, viewport, fov).pitchDegrees, -89);
  assert.equal(freeViewFocalLengthAfterPinch(24, 100, 200), 48);
  assert.equal(freeViewFocalLengthAfterPinch(24, 100, 50), 12);
  assert.equal(freeViewFocalLengthAfterPinch(24, 100, 1), 9);
  assert.equal(freeViewFocalLengthAfterPinch(1000, 100, 400), 1600);
  assert.equal(clampFreeViewFocalLengthMm(Number.NaN), 24);
  // 向き・画角をどう変えても、視点のECEFは変わらない。
  const base = freeViewCameraModel({ observer, lensCenterHeightMeters: 1.5, headingDegrees: 0, pitchDegrees: 0, focalLengthMm: 24, aspectRatio: 0.5 });
  let pose = start;
  for (let step = 0; step < 200; step += 1) {
    pose = freeViewPoseAfterDrag(pose, -37, step % 2 ? 11 : -13, viewport, fov);
    const model = freeViewCameraModel({ observer, lensCenterHeightMeters: 1.5, ...pose, focalLengthMm: freeViewFocalLengthAfterPinch(24, 100, 100 + step * 5), aspectRatio: 0.5 });
    assert.equal(Cartesian3.distance(model.observerEcef, base.observerEcef), 0);
  }
});

test("FV-08/09: sun, moon and milky way with tracks at the observer only, in the observer's time zone", () => {
  const dateTimeLocal = "2026-10-20T12:00";
  const range = freeViewDayRange(dateTimeLocal, "Asia/Tokyo");
  assert.equal(range.date.toISOString(), "2026-10-20T03:00:00.000Z");
  assert.equal(range.dayStart.toISOString(), "2026-10-19T15:00:00.000Z");
  assert.equal(range.dayEnd.toISOString(), "2026-10-20T15:00:00.000Z");
  // 端末のタイムゾーンと無関係に、指定したタイムゾーンの壁時計で決まる。
  assert.equal(freeViewDayRange(dateTimeLocal, "America/New_York").date.toISOString(), "2026-10-20T16:00:00.000Z");
  assert.equal(freeViewDayRange("bad", "Asia/Tokyo"), null);

  // 太陽の真の位置（被写体なしの直接計算）へ視線を向けると、太陽は画面中央に来る。
  const lens = { ...observer, height: 1041.5, ellipsoidalHeightMeters: 1041.5, orthometricHeightMeters: 1001.5 };
  const sun = celestial.calculateCelestialHorizontalCoordinates("sun", range.date, lens, "standard");
  assert.ok(sun.altitudeDegrees > 30, "正午の太陽は高い");
  const model = createFreeViewCameraModel(observer, sun.azimuthDegrees, sun.altitudeDegrees, 1.5, 200, 0.5);
  const samples = freeViewTrackSamples(model.observerPoint, "standard", range, "Asia/Tokyo", freeViewTrackSampleMinutes(model), "sun");
  assert.deepEqual(samples.map((track) => track.id), ["sun"], "選択中の天体だけ計算する");
  // 選択日の前後12時間まで延長（深夜をまたぐ通過が途切れない）。
  assert.equal(samples[0].samples[0].timestampMilliseconds, range.dayStart.getTime() - 12 * 3_600_000);
  assert.equal(samples[0].samples.at(-1).timestampMilliseconds, range.dayEnd.getTime() + 12 * 3_600_000);
  const frame = freeViewCelestialFrame({ model, date: range.date, calculationMode: "standard", body: "sun", showCelestial: true, showTracks: true, trackSamples: samples });
  const sunPoint = frame.points.find((point) => point.id === "sun");
  assert.ok(Math.abs(sunPoint.xPercent - 50) < 1e-6 && Math.abs(sunPoint.yPercent - 50) < 1e-6);
  assert.equal(sunPoint.visibleInFrame, true);
  assert.ok(Math.abs(sunPoint.azimuthDegrees - sun.azimuthDegrees) < 1e-9);
  assert.deepEqual(frame.visibility, { sun: true, moon: false, milkyWay: false, polaris: false });
  assert.equal(frame.occlusion.sun, undefined, "地平線より上: 隠れているとは表示しない（地形遮蔽は未判定）");
  // 軌跡は1回の通過だけ（延長範囲に入る前日・翌日の通過は取り除く）で、選択時刻を含む。
  const track = frame.tracks[0];
  assert.equal(frame.tracks.length, 1);
  assert.ok(track.points.every((point) => point.altitudeDegrees >= -1));
  assert.ok(track.points[0].timestampMilliseconds <= range.date.getTime() && track.points.at(-1).timestampMilliseconds >= range.date.getTime());
  assert.ok(track.points.at(-1).timestampMilliseconds - track.points[0].timestampMilliseconds < 16 * 3_600_000);
  // 軌跡の各点は、既存の被写体ありの軌跡計算と同じ天体計算（同じ時刻なら同じ方位・高度）。
  const reference = celestial.calculateCelestialTrackSamples(model.observerPoint, "standard", range.dayStart, range.dayEnd, "Asia/Tokyo", freeViewTrackSampleMinutes(model), undefined, ["sun"])[0];
  const byTime = new Map(track.points.map((point) => [point.timestampMilliseconds, point]));
  let compared = 0;
  for (const sample of reference.samples) {
    const point = byTime.get(sample.timestampMilliseconds);
    if (!point) continue;
    assert.equal(point.azimuthDegrees, sample.azimuthDegrees);
    assert.equal(point.altitudeDegrees, sample.altitudeDegrees);
    compared += 1;
  }
  assert.ok(compared > 100);

  // 視線を180度回すと、同じ時刻の太陽は背面（画面に出ない）。位置の古い値は残らない。
  const turned = createFreeViewCameraModel(observer, sun.azimuthDegrees + 180, 0, 1.5, 200, 0.5);
  const behind = freeViewCelestialFrame({ model: turned, date: range.date, calculationMode: "standard", body: "sun", showCelestial: true, showTracks: true, trackSamples: samples });
  assert.equal(behind.points.find((point) => point.id === "sun").inFront, false);

  // 夜: 太陽は地平線の下 → 円盤ではなく位置だけの表示。
  const night = freeViewDayRange("2026-10-20T23:30", "Asia/Tokyo");
  const nightSun = celestial.calculateCelestialHorizontalCoordinates("sun", night.date, lens, "standard");
  assert.ok(nightSun.altitudeDegrees < 0);
  const nightFrame = freeViewCelestialFrame({ model, date: night.date, calculationMode: "standard", body: "sun", showCelestial: true, showTracks: false, trackSamples: [] });
  assert.equal(nightFrame.occlusion.sun.reason, "below-horizon");
  assert.deepEqual(nightFrame.tracks, []);

  // 月: 月相（輝面比など）は既存の計算のまま付く。日付境界（23:30→翌0:30）で日が切り替わる。
  const moonSamples = freeViewTrackSamples(model.observerPoint, "standard", night, "Asia/Tokyo", 10, "moon");
  const moonFrame = freeViewCelestialFrame({ model, date: night.date, calculationMode: "standard", body: "moon", showCelestial: true, showTracks: true, trackSamples: moonSamples });
  const moonPoint = moonFrame.points.find((point) => point.id === "moon");
  assert.ok(moonPoint.illuminationFraction >= 0 && moonPoint.illuminationFraction <= 1);
  assert.equal(moonFrame.visibility.moon, true);
  assert.equal(moonFrame.tracks[0].id, "moon");
  const nextDay = freeViewDayRange("2026-10-21T00:30", "Asia/Tokyo");
  assert.equal(nextDay.dayStart.getTime(), night.dayEnd.getTime());

  // 天の川: その時刻の銀河面の帯（73点）と、銀河中心の時間軌跡は別のデータ。
  const milkySamples = freeViewTrackSamples(model.observerPoint, "standard", night, "Asia/Tokyo", 10, "milkyWay");
  const milkyFrame = freeViewCelestialFrame({ model, date: night.date, calculationMode: "standard", body: "milkyWay", showCelestial: true, showTracks: true, trackSamples: milkySamples });
  assert.equal(milkyFrame.milkyWayPath.length, 73);
  assert.ok(milkyFrame.milkyWayPath.every((point) => point.lineOfSightVisible === (point.altitudeDegrees > 0)), "地平線より下の帯は塗らない");
  assert.equal(milkyFrame.tracks[0].id, "milkyWay");
  assert.equal(milkyFrame.visibility.milkyWay, true);
  // 本体を消して軌跡だけ残せる。両方消すと何も出ない。
  const tracksOnly = freeViewCelestialFrame({ model, date: night.date, calculationMode: "standard", body: "moon", showCelestial: false, showTracks: true, trackSamples: moonSamples });
  assert.deepEqual(tracksOnly.points, []);
  assert.equal(tracksOnly.tracks.length, 1);
  assert.equal(tracksOnly.visibility.moon, true);
  const nothing = freeViewCelestialFrame({ model, date: night.date, calculationMode: "standard", body: "moon", showCelestial: false, showTracks: false, trackSamples: moonSamples });
  assert.deepEqual([nothing.points, nothing.tracks, nothing.milkyWayPath], [[], [], []]);
  assert.equal(nothing.visibility.moon, false);

  // 観測地点が変われば天体の位置も変わる（那覇と札幌で太陽高度が違う）。
  const naha = celestial.calculateCelestialHorizontalCoordinates("sun", range.date, ground(26.21, 127.68, 10, 30), "standard");
  const sapporo = celestial.calculateCelestialHorizontalCoordinates("sun", range.date, ground(43.06, 141.35, 20, 30), "standard");
  assert.ok(naha.altitudeDegrees - sapporo.altitudeDegrees > 10);
});

test("FV-04/11: the search decides the standing point on the ground; late results never overwrite", async () => {
  assert.deepEqual(parseFreeViewCoordinateQuery("35.3606, 138.7274"), { latitude: 35.3606, longitude: 138.7274, label: "35.36060, 138.72740" });
  assert.deepEqual(parseFreeViewCoordinateQuery("３５.１、１３６.９").latitude, 35.1);
  assert.equal(parseFreeViewCoordinateQuery("東京タワー"), null);
  assert.equal(parseFreeViewCoordinateQuery("95, 200"), null);

  // 座標は通信せずに読む。URL・地名は既存の resolveSpotLocation へ渡す。
  const calls = [];
  const fakeResolve = async (query) => { calls.push(query); return { latitude: 35.6586, longitude: 139.7454, label: "東京タワー", subjectSurfaceTarget: "structure-roof", structureHeightMeters: 333 }; };
  const controller = new AbortController();
  await resolveFreeViewDirectLocation("35.1, 136.9", controller.signal, fakeResolve);
  assert.equal(calls.length, 0);
  const tower = await resolveFreeViewDirectLocation("https://maps.app.goo.gl/abc", controller.signal, fakeResolve);
  assert.deepEqual(calls, ["https://maps.app.goo.gl/abc"]);
  // 塔の検索結果でも、頂上の情報は持ち込まない（立つ場所は地表）。
  assert.deepEqual(tower, { latitude: 35.6586, longitude: 139.7454, label: "東京タワー" });

  const groundCalls = [];
  const observerGround = await resolveFreeViewObserverGround(tower, async (latitude, longitude, label) => {
    groundCalls.push([latitude, longitude, label]);
    return ground(latitude, longitude, 18, 36.7, label);
  });
  assert.deepEqual(groundCalls, [[35.6586, 139.7454, "東京タワー"]]);
  assert.equal(observerGround.orthometricHeightMeters, 18, "塔の高さ333mは足さない");
  assert.equal(observerGround.label, "東京タワー");
  // 高さを取得できない時は失敗のまま返す（高さ0mで視点を確定しない）。
  await assert.rejects(
    resolveFreeViewObserverGround(tower, async () => { throw new Error("標高を取得できません"); }),
    /標高を取得できません/
  );

  // 連続検索: 後から始めた検索だけが有効。古い検索は中止され、結果は捨てられる。
  const guard = createLatestOnlyGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  guard.cancel();
  assert.equal(second.isCurrent(), false);
  assert.equal(guard.begin().isCurrent(), true, "中止後も再検索できる");
});

test("FV-01/02/03/07/12/13: independent screen, no subject, no device sensors, one shared viewer restored on close", async () => {
  const sources = await Promise.all([
    "src/components/FreeViewScreen.tsx", "src/components/FreeViewGestureLayer.tsx", "src/components/FreeViewSpotSearch.tsx",
    "src/cesium/freeViewCamera.ts", "src/freeView/freeViewCelestial.ts", "src/search/freeViewObserverSearch.ts",
  ].map(read));
  // コメントを除いた実コードで確認する。
  const code = sources.map((text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
  // 端末センサー・ARの権限要求・カメラ映像・GPSを使わない。
  assert.doesNotMatch(code, /deviceorientation|devicemotion|DeviceOrientationEvent|requestArOrientationPermission|getUserMedia|geolocation|Gyroscope|AbsoluteOrientationSensor/i);
  // 被写体を使わない（被写体ありのカメラモデル・投影・仮の被写体も使わない）。
  assert.doesNotMatch(code, /subjectPoint|createCameraModel\(|createCameraProjection\(|calculateCelestialScreenTracks\(|calculateMilkyWayScreenPath\(|calculateCelestialScreenPoints\(/);
  // 通常画面のピン・履歴・内蔵スポット登録を変更しない。
  assert.doesNotMatch(code, /setTripodPoint|setSubjectPoint|ensureDynamicSpot|rememberUnresolvedDynamicStructure|upsertDownloadedSpotData|saveProject|localStorage/);
  // 2つ目のViewerを作らない。Google 3Dの形状を測らない（高さ・遮蔽の採取をしない）。
  assert.doesNotMatch(code, /createMapViewer|new Viewer\(|sampleHeight|clampToHeight|pickPosition|pickFromRay|drillPick/);
  // ストリートビューは実装しない。
  assert.doesNotMatch(code, /street\s*view|StreetView|ストリートビュー/i);

  const screen = sources[0];
  // 入る直前の状態を控え、閉じる時に戻す。描画ループ・監視も止める。
  assert.match(screen, /const snapshot = captureFreeViewViewerSnapshot\(viewer\);\s*lockFreeViewViewerInputs\(viewer\);/);
  assert.match(screen, /if \(rafId !== null\) cancelAnimationFrame\(rafId\);[\s\S]*?viewer\.entities\.show = entitiesWereShown;[\s\S]*?restoreFreeViewViewer\(viewer, snapshot\);/);
  assert.match(screen, /observerInstance\.disconnect\(\)/);
  assert.match(screen, /useState<GroundPoint \| null>\(initialObserver\)/);
  assert.match(screen, /useState\(initialObserver === null\)/, "三脚ピンが無ければスポット検索を開く");
  assert.match(screen, /useState<FreeViewPose>\(\{ headingDegrees: 0, pitchDegrees: 0 \}\)/, "初期は真北・水平");

  const camera = sources[3];
  assert.match(camera, /controller\.enableInputs = false;/);
  assert.match(camera, /destination: model\.observerEcef,/);

  const app = await read("src/App.tsx");
  // 同じコンテナを自由ビューのホストへ移す（Viewerは1つ）。
  assert.match(app, /const host = freeViewOpen\s*\? freeViewHost\s*: mapDisplayMode === "3d" \? map3DHostRef\.current : previewMapHostRef\.current;/);
  // 自由ビュー中は、3D地図の操作・タップ配置と、プレビュー撮影を止める。
  assert.match(app, /if \(mapDisplayMode !== "3d" \|\| freeViewOpen\) return;/);
  assert.match(app, /if \(freeViewOpen\) return;/);
  // 入口はARとは別。センサーの許可を求めない。開いた瞬間の値をコピーして渡す。
  assert.match(app, /onOpenFreeView=\{\(\) => \{[^}]*?setFreeViewSession\(\{\s*observer: tripodPoint,/);
  const openHandler = app.slice(app.indexOf("onOpenFreeView={"), app.indexOf("onOpenMap3D={toggleMapDisplayMode}"));
  assert.doesNotMatch(openHandler, /requestArOrientationPermission|subjectPoint/);
  assert.match(app, /onClose=\{\(\) => setFreeViewSession\(null\)\}/);
  const menu = await read("src/components/TopSettingsBar.tsx");
  assert.match(menu, /onOpenFreeView\(\);\s*\}\}>\s*<b>自由ビューモード<\/b>/);
  assert.match(menu, /<b>ARカメラ<\/b>/, "ARの入口はそのまま");

  // ロゴ・提供元の表示を操作パネルやジェスチャーで覆わない。
  const css = await read("src/App.css");
  // 画面は「景観」と「時間軸」の2段だけ。時間軸は景観の外（下）。検索は画面全体に重ねる。
  assert.match(css, /\.free-view-screen \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.free-view-search \{ position: fixed; z-index: 10500; inset: 0;/);
  // 操作は 戻る・天体選択・スポット検索・メイン画面と同じ時間軸 だけ（方位・仰角などの数値欄は置かない）。
  assert.match(screen, /className="free-view-back" onClick=\{onClose\}>戻る</);
  assert.match(screen, /className="free-view-search-open" onClick=\{\(\) => setSearchOpen\(true\)\}>/);
  assert.match(screen, /<TimelinePanel\s+dateTimeLocal=\{dateTimeLocal\}\s+location=\{observer\}/);
  assert.doesNotMatch(screen, /<input|type="number"|方位 |仰角 /);
  // 時間軸の「天体通過日時検索」ボタンは、渡した画面（メイン・AR）にだけ出る。
  const timeline = await read("src/components/TimelinePanel.tsx");
  assert.match(timeline, /\{onOpenTransitSearch && \(/);
  assert.match(app, /onOpenTransitSearch=\{openCelestialTransitSearch\}/);
  assert.match(css, /\.free-view-host \.cesium-widget-credits \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(css, /\.free-view-gesture-layer \{[^}]*inset: 0 0 30px 0;/);
});
