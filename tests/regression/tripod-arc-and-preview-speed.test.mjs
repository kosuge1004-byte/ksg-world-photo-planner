import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  alignRiseSetArcToConfirmedCandidates,
  buildTripodCandidateRiseSetArc,
} from "../../src/cesium/tripodCandidateRiseSetArc.ts";
import { buildTripodSearchBaseLines } from "../../src/cesium/tripodSearchLine.ts";
import { selectFarthestVerifiedCandidate } from "../../src/cache/tripodBearingProfileManager.ts";

test("ground base line follows the current celestial azimuth independently of tripod placement", () => {
  const subject = { latitude: 35, longitude: 138, height: 100, label: "subject" };
  const points = [{
    id: "moon",
    label: "月",
    azimuthDegrees: 10,
    altitudeDegrees: 25,
    xPercent: 50,
    yPercent: 50,
    visibleInFrame: false,
  }];
  const lines = buildTripodSearchBaseLines(
    subject,
    points,
    { sun: false, moon: true, milkyWay: false, polaris: false }
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "moon");
  assert.equal(lines[0].bearingDegrees, 190);
  const moved = buildTripodSearchBaseLines(
    subject,
    [{ ...points[0], azimuthDegrees: 20 }],
    { sun: false, moon: true, milkyWay: false, polaris: false }
  );
  assert.equal(moved[0].bearingDegrees, 200);
  assert.equal(
    buildTripodSearchBaseLines(
      subject,
      [{ ...points[0], altitudeDegrees: -5 }],
      { sun: false, moon: true, milkyWay: false, polaris: false }
    ).length,
    0
  );
});

test("confirmed tripod candidates remain points and are not joined by an extra legacy arc", async () => {
  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(map2d, /candidates\.map\(\(candidate\)/);
  assert.match(map2d, /map-tripod-candidate-marker/);
  assert.match(entities, /candidates\.forEach\(\(candidate, index\)/);
  assert.match(entities, /pixelSize:\s*15/);
  assert.doesNotMatch(map2d, /map-tripod-candidate-arc/);
  assert.doesNotMatch(entities, /三脚候補円弧/);
  assert.match(
    app,
    /updateTripodCandidateEntities\([\s\S]*?viewer,[\s\S]*?visibleCandidates,[\s\S]*?tripodCandidateRiseSetArcs/
  );
});

test("sun, moon and Milky Way rise-to-set guides stay inside the configured search range", async () => {
  const dayStart = new Date("2026-10-02T15:00:00.000Z"); // 2026-10-03 00:00 JST
  const dayEnd = new Date("2026-10-03T15:00:00.000Z");
  const gifuCastle = {
    latitude: 35.43392,
    longitude: 136.78215,
    height: 329,
    ellipsoidalHeightMeters: 329,
    label: "岐阜城",
  };
  for (const id of ["sun", "moon", "milkyWay"]) {
    const arc = buildTripodCandidateRiseSetArc({
      id,
      subject: gifuCastle,
      dayStart,
      dayEnd,
      lensCenterHeightMeters: 1.6,
      calculationMode: "pro",
      maxDistanceMeters: 10_000,
    });
    assert.ok(arc, `${id} arc`);
    assert.ok(arc.riseAt >= dayStart && arc.riseAt < dayEnd);
    assert.ok(arc.setAt > arc.riseAt);
    assert.ok(arc.points.length >= 2);
    assert.ok(arc.points.every((point) => point.id === id));
    assert.ok(arc.points.every((point) => point.solutionType === "preliminary"));
    assert.ok(arc.points.every((point) => point.distanceMeters <= 10_000));
  }

  const map2d = await readFile(new URL("../../src/components/Map2DOverlay.tsx", import.meta.url), "utf8");
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(map2d, /map-tripod-rise-set-arc/);
  assert.match(entities, /の出から入までの三脚候補線/);
  assert.match(app, /buildTripodCandidateRiseSetArc/);
  assert.match(app, /candidateRiseSetArcs=\{tripodCandidateRiseSetArcs\}/);
});

test("the exact current candidate is inserted into the same-time rise-set guide", () => {
  const arc = {
    id: "moon",
    riseAt: new Date("2026-10-03T00:00:00Z"),
    setAt: new Date("2026-10-03T03:00:00Z"),
    points: [0, 1, 2].map((hour) => ({
      id: "moon",
      label: "月",
      latitude: 35 + hour * 0.01,
      longitude: 138,
      height: 100,
      distanceMeters: 1_000 + hour,
      solutionType: "preliminary",
      timestampMilliseconds: Date.parse(`2026-10-03T0${hour}:00:00Z`),
    })),
  };
  const exact = {
    id: "moon",
    label: "月",
    latitude: 35.123456,
    longitude: 138.654321,
    height: 210,
    distanceMeters: 2_345,
    solutionType: "aligned",
  };
  const aligned = alignRiseSetArcToConfirmedCandidates(
    arc,
    [exact],
    new Date("2026-10-03T01:02:00Z")
  );
  assert.equal(aligned.points.length, 3);
  assert.ok(aligned.points.some((point) =>
    point.latitude === exact.latitude && point.longitude === exact.longitude
  ));
});

test("multiple cached intersections collapse to the same farthest candidate as the authoritative search", () => {
  const candidates = [837, 1_082, 897].map((distanceMeters, index) => ({
    id: "moon",
    label: "月",
    latitude: 35 + index * 0.001,
    longitude: 138,
    height: 100,
    distanceMeters,
    solutionType: "aligned",
    intersectionIndex: index + 1,
    intersectionCount: 3,
  }));
  const selected = selectFarthestVerifiedCandidate(candidates);
  assert.ok(selected);
  assert.equal(selected.distanceMeters, 1_082);
  assert.equal(selected.intersectionIndex, 1);
  assert.equal(selected.intersectionCount, 1);
});

test("rise-set guide inserts only one farthest point and ignores candidates outside its active date interval", () => {
  const arc = {
    id: "moon",
    riseAt: new Date("2026-10-04T15:00:00Z"),
    setAt: new Date("2026-10-05T05:30:00Z"),
    points: [0, 1, 2].map((hour) => ({
      id: "moon",
      label: "月",
      latitude: 35 + hour * 0.01,
      longitude: 138,
      height: 100,
      distanceMeters: 900,
      solutionType: "preliminary",
      timestampMilliseconds: Date.parse(`2026-10-04T${15 + hour}:00:00Z`),
    })),
  };
  const candidates = [837, 1_082, 897].map((distanceMeters, index) => ({
    id: "moon",
    label: "月",
    latitude: 36 + index * 0.01,
    longitude: 139,
    height: 110,
    distanceMeters,
    solutionType: "aligned",
  }));

  const aligned = alignRiseSetArcToConfirmedCandidates(
    arc,
    candidates,
    new Date("2026-10-04T16:08:00Z")
  );
  assert.equal(aligned.points.length, arc.points.length);
  assert.equal(
    aligned.points.filter((point) => point.distanceMeters === 1_082).length,
    1,
    "候補線へは最遠の現在候補1件だけを挿入する"
  );

  const outside = alignRiseSetArcToConfirmedCandidates(
    arc,
    candidates,
    new Date("2026-10-05T08:00:00Z")
  );
  assert.deepEqual(outside, arc, "月没後の古い候補で線を変形しない");
});

test("rise-set guides use thinner red dashes and 3D adds the white camera sight line", async () => {
  const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
  const candidateEntities = await readFile(
    new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url),
    "utf8"
  );
  const sightLine = await readFile(
    new URL("../../src/cesium/tripodSubjectSightLineEntities.ts", import.meta.url),
    "utf8"
  );
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");

  assert.match(css, /\.map-tripod-rise-set-arc\s*\{[\s\S]*?stroke:\s*rgba\(255, 42, 42, \.98\);[\s\S]*?stroke-width:\s*\.625;[\s\S]*?stroke-dasharray:\s*6 4;/);
  assert.match(candidateEntities, /PolylineDashMaterialProperty/);
  assert.match(candidateEntities, /width:\s*viewer\.scene\.globe\?\.show === true \? 0\.625 : 2\.5/);
  assert.match(candidateEntities, /Color\.RED\.withAlpha\(0\.98\)/);
  assert.match(sightLine, /Color\.WHITE\.withAlpha/);
  assert.match(sightLine, /PolylineDashMaterialProperty/);
  assert.match(sightLine, /ellipsoidalHeightMeters\(tripod\) \+ lensCenterHeightMeters/);
  assert.match(sightLine, /arcType:\s*ArcType\.NONE/);
  assert.match(app, /mapDisplayMode !== "3d"[\s\S]*?clearTripodSubjectSightLineEntity/);
  assert.match(app, /updateTripodSubjectSightLineEntity\([\s\S]*?subjectPoint,[\s\S]*?tripodPoint,[\s\S]*?cameraSettings\.lensCenterHeightMeters/);
});

test("downloaded bearing profiles are read in one transaction before exact refinement", async () => {
  const manager = await readFile(new URL("../../src/cache/tripodBearingProfileManager.ts", import.meta.url), "utf8");
  assert.match(manager, /const profiles = await getBearingProfilesMany\(/);
  assert.doesNotMatch(manager, /await getBearingProfile\(/);
  assert.match(manager, /calculateTripodCandidates\(/);
});

test("upper preview is progressive, bounded to six seconds, and keeps its preview camera warm", async () => {
  const preview = await readFile(new URL("../../src/cesium/previewSnapshot.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const viewer = await readFile(new URL("../../src/cesium/createMapViewer.ts", import.meta.url), "utf8");

  assert.match(preview, /PREVIEW_INITIAL_TILE_WAIT_TIMEOUT_MS = 4_000/);
  assert.match(preview, /PREVIEW_REFINEMENT_TILE_WAIT_TIMEOUT_MS = 2_000/);
  assert.match(preview, /PREVIEW_FRAME_COPY_INTERVAL_MS = 240/);
  assert.match(app, /PREVIEW_INITIAL_TILE_WAIT_TIMEOUT_MS/);
  assert.match(app, /PREVIEW_REFINEMENT_TILE_WAIT_TIMEOUT_MS/);
  assert.match(app, /tileWaitTimeoutMs,[\s\S]*?false\s*\)/);
  assert.match(viewer, /viewer\.terrainProvider = terrainProvider/);
  assert.match(app, /heightMeters: mapDisplayModeRef\.current === "3d" \? 1_200 : 2_000_000/);
  // 2026-10-05: 上部プレビューは天体が通る線だけを黄色で描く。
  assert.match(app, /<CelestialOverlay[\s\S]*?tracks=\{previewCelestialTracksForNow\}[\s\S]*?trackTone="yellow"/);
});

test("timeline commits its latest frame and timezone updates cannot restore an old timestamp", async () => {
  const timeline = await readFile(new URL("../../src/components/TimelinePanel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(timeline, /const flushPendingTimelineTime = useCallback/);
  assert.match(timeline, /timelineDragRef\.current = null;\s*flushPendingTimelineTime\(\);\s*onInteractionChange\?\.\(false\)/);
  assert.match(timeline, /wheelIdleTimerRef\.current = null;\s*flushPendingTimelineTime\(\);/);
  assert.match(app, /const previousTimeZone = timeZoneRef\.current;[\s\S]*?dateFromZonedDateTimeLocal\(\s*dateTimeLocalRef\.current,[\s\S]*?previousTimeZone/);
});

test("upper preview hides map guide lines by syncing entity visibility before every captured frame", async () => {
  const preview = await readFile(new URL("../../src/cesium/previewSnapshot.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
  assert.match(preview, /viewer\.dataSourceDisplay\.update\(viewer\.clock\.currentTime\)/);
  assert.match(preview, /defaultDataSource\.show = false;\s*syncEntityVisibility\(viewer\);/);
  assert.match(preview, /syncEntityVisibility\(viewer\);\s*viewer\.scene\.requestRender\(\);\s*viewer\.scene\.render\(\);/);
  assert.match(css, /\.celestial-track-tone-yellow \.celestial-track-line\s*\{\s*stroke:\s*rgba\(255, 221, 0/);
});

test("3D rise-set guide is draped on the surface so it cannot slide when the camera moves", async () => {
  const entities = await readFile(new URL("../../src/cesium/tripodCandidateEntities.ts", import.meta.url), "utf8");
  assert.match(entities, /clampToGround:\s*true/);
  assert.match(entities, /classificationType:\s*ClassificationType\.BOTH/);
  assert.doesNotMatch(entities, /depthFailMaterial:/);
  assert.doesNotMatch(entities, /fromDegreesArrayHeights/);
});

test("rise-set guide stays smooth through a confirmed candidate that sits on real terrain", async () => {
  const { Cartesian3, Cartographic, Math: CesiumMath } = await import("cesium");
  const { buildCelestialBackwardRay } = await import("../../src/cesium/tripodCandidates.ts");
  const { calculateCelestialHorizontalCoordinates } = await import("../../src/cesium/celestial.ts");

  // 138タワーパーク付近。地表の楕円体高は約48m（楕円体面より十分高い）。
  const subject = {
    latitude: 35.3445, longitude: 136.7870, height: 180,
    ellipsoidalHeightMeters: 180, label: "塔",
  };
  const lens = 1.6;
  const groundHeight = 48;
  const arc = buildTripodCandidateRiseSetArc({
    id: "moon",
    subject,
    dayStart: new Date("2026-10-03T15:00:00.000Z"),
    dayEnd: new Date("2026-10-04T15:00:00.000Z"),
    lensCenterHeightMeters: lens,
    calculationMode: "pro",
    maxDistanceMeters: 30_000,
  });
  assert.ok(arc);

  // 月出の約45分後。精密解に相当する「視線レイが実地表+レンズ高へ届く地点」を作る。
  const now = new Date(arc.riseAt.getTime() + 45 * 60_000);
  const observer = { ...subject, height: subject.height + lens, ellipsoidalHeightMeters: subject.height + lens };
  const horizontal = calculateCelestialHorizontalCoordinates("moon", now, observer, "pro");
  const ray = buildCelestialBackwardRay(
    subject, horizontal.azimuthDegrees, horizontal.geometricAltitudeDegrees, observer
  );
  let low = 0;
  let high = 100_000;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    const position = Cartesian3.add(
      ray.origin, Cartesian3.multiplyByScalar(ray.direction, middle, new Cartesian3()), new Cartesian3()
    );
    if (Cartographic.fromCartesian(position).height > groundHeight + lens) low = middle;
    else high = middle;
  }
  const hit = Cartographic.fromCartesian(Cartesian3.add(
    ray.origin, Cartesian3.multiplyByScalar(ray.direction, high, new Cartesian3()), new Cartesian3()
  ));
  const confirmed = {
    id: "moon",
    label: "月",
    latitude: CesiumMath.toDegrees(hit.latitude),
    longitude: CesiumMath.toDegrees(hit.longitude),
    height: groundHeight,
    distanceMeters: high,
    solutionType: "aligned",
  };

  const aligned = alignRiseSetArcToConfirmedCandidates(arc, [confirmed], now);
  const index = aligned.points.findIndex((point) => point.solutionType === "aligned");
  assert.ok(index > 0 && index < aligned.points.length - 1, "確定候補は線の途中へ時刻順に入る");
  assert.ok(
    aligned.points.every((point, i) =>
      i === 0 || point.timestampMilliseconds > aligned.points[i - 1].timestampMilliseconds
    ),
    "頂点は時刻順"
  );

  // 月が昇るほど三脚は被写体へ近づく。確定候補の前後で距離が単調に並ぶこと
  // （以前は確定候補だけ手前へ引き込まれ、前後の頂点が両方とも遠いV字になっていた）。
  const before = aligned.points[index - 1];
  const after = aligned.points[index + 1];
  assert.ok(before.distanceMeters > confirmed.distanceMeters, "直前の頂点は確定候補より遠い");
  assert.ok(after.distanceMeters < confirmed.distanceMeters, "直後の頂点は確定候補より近い");

  // 旧実装（楕円体高0m基準の線へ1点だけ差し替え）ではここが成り立たない。
  const legacyAfter = arc.points.find((point) => point.timestampMilliseconds > now.getTime());
  assert.ok(legacyAfter.distanceMeters > confirmed.distanceMeters, "旧基準の線は確定候補より遠い側に残る");

  // 方位だけ合わせた確認地点は線の頂点にしない。
  const directionOnly = alignRiseSetArcToConfirmedCandidates(
    arc, [{ ...confirmed, solutionType: "direction-only", distanceMeters: 500 }], now
  );
  assert.ok(directionOnly.points.every((point) => point.solutionType === "preliminary"));
});

test("moon age calendar jumps to the tapped day's moonrise using the timeline's own rule", async () => {
  const calendar = await readFile(new URL("../../src/components/MoonAgeCalendarScreen.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(calendar, /onClick=\{\(\) => \{ setSelectedKey\(day\.key\); onJumpToDate\?\.\(day\.key\); \}\}/);
  assert.match(app, /onJumpToDate=\{handleMoonCalendarJump\}/);
  // タイムラインの「月出」と同じく、その日の0時〜翌0時で最初に昇る時刻。
  assert.match(app, /findHorizonCrossing\(\s*"moon",\s*1,\s*input\.location,\s*dateFromZonedDateTimeLocal\(`\$\{dateKey\}T00:00`, input\.timeZone\),\s*dateFromZonedDateTimeLocal\(`\$\{nextKey\}T00:00`, input\.timeZone\)/);
  assert.match(app, /setDateTimeLocal\(zonedDateTimeLocalFromDate\(moonrise, input\.timeZone\)\)/);
  // 月の出が無い日は日付だけ移動し、黙って別の日の月の出へ飛ばない。
  assert.match(app, /月の出がありません/);
  assert.match(app, /location: tripodPoint \?\? subjectPoint/);
});

test("timeline bar is as thick as a 10-minute tick and shows day, golden hour, blue hour and each twilight", async () => {
  const { timelineSunColor } = await import("../../src/time/timelineSunColor.ts");
  const panel = await readFile(new URL("../../src/components/TimelinePanel.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.timeline-sun-bar \{[^}]*height: 7px/);
  assert.match(css, /\.timeline-scroll-tick \{[^}]*height: 7px/);

  const rgb = (altitude) => timelineSunColor(altitude).match(/\d+/g).map(Number);
  assert.deepEqual(rgb(30), [255, 140, 20], "昼はオレンジ");
  assert.deepEqual(rgb(6), [255, 140, 20]);
  assert.deepEqual(rgb(3), [255, 200, 40], "ゴールデンアワーは金色");
  assert.deepEqual(rgb(-5), [70, 185, 255], "ブルーアワーは明るい水色");
  assert.deepEqual(rgb(-6), [36, 93, 229], "市民薄明と航海薄明の境は従来の青");
  assert.deepEqual(rgb(-12), [27, 54, 150], "航海薄明と天文薄明の境");
  assert.deepEqual(rgb(-18), [22, 36, 104], "夜は濃紺");
  assert.deepEqual(rgb(-40), [22, 36, 104]);
  // 各段階が見分けられること: 昼→夜へ向かって青成分が増え、赤成分が減る区間がある。
  assert.ok(rgb(0)[0] > rgb(-5)[0] && rgb(-5)[2] > rgb(0)[2]);
  assert.ok(rgb(-9)[2] > rgb(-15)[2] && rgb(-15)[2] > rgb(-18)[2]);
  // 色の再計算は10分をまたぐときだけ（ドラッグ中の毎フレームではない）。
  assert.match(panel, /\[timelineFirstTickTime, timelineBarDurationMs, location, calculationMode, refractionWeather\]/);
  assert.match(panel, /TIMELINE_SUN_SAMPLE_MS = 2 \* 60_000/);
});

test("startup restores the previous date, time zone and pins, and ignores damaged saved values", async () => {
  const { parseLastSession } = await import("../../src/storage/lastSession.ts");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const subject = { latitude: 35.3445, longitude: 136.787, height: 180, label: "塔", subjectSurfaceTarget: "structure-roof" };
  const tripod = { latitude: 35.33, longitude: 136.75, height: 48, label: "三脚" };

  const restored = parseLastSession(
    "2026-10-06T23:10",
    JSON.stringify({ timeZone: "Asia/Tokyo", subject, tripod })
  );
  assert.equal(restored.dateTimeLocal, "2026-10-06T23:10");
  assert.equal(restored.timeZone, "Asia/Tokyo");
  assert.deepEqual(restored.subject, subject, "高さの種別などの付随情報も失わない");
  assert.deepEqual(restored.tripod, tripod);

  // 初回起動・旧データ（ピン未保存）
  assert.deepEqual(parseLastSession(null, null), { dateTimeLocal: null, timeZone: null, subject: null, tripod: null });
  assert.equal(parseLastSession("2026-10-06T23:10", null).dateTimeLocal, "2026-10-06T23:10");

  // 壊れた値はその項目だけ捨てる
  const damaged = parseLastSession("2026-13-40T99:99", JSON.stringify({
    timeZone: "Nowhere/Invalid",
    subject: { latitude: 95, longitude: 136, height: 0, label: "x" },
    tripod,
  }));
  assert.equal(damaged.dateTimeLocal, null);
  assert.equal(damaged.timeZone, null);
  assert.equal(damaged.subject, null);
  assert.deepEqual(damaged.tripod, tripod);
  assert.equal(parseLastSession("not a date", "{broken").subject, null);

  assert.match(app, /loadLastSession\(\)\.dateTimeLocal \?\?/);
  assert.match(app, /useState\(loadInitialTimeZone\)/);
  // 復元が済むまで保存しない（起動直後の「ピンなし」で上書きしない）。
  assert.match(app, /if \(!lastSessionRestoreDone\) return;\s*saveLastSessionPins\(timeZone, subjectPoint, tripodPoint\);/);
  // 共有リンクの取り込みや、先に置かれたピンを上書きしない。
  assert.match(app, /if \(!sharedImportPayload && !subjectPoint && !tripodPoint\) \{/);
});

test("upper preview draws only the pass the selected time belongs to, never tomorrow's as a second line", async () => {
  const { selectCelestialTrackPass } = await import("../../src/cesium/celestialTrackPass.ts");
  const hour = 3_600_000;
  const base = Date.parse("2026-10-06T15:00:00.000Z"); // 10/07 00:00 JST
  // 月: 10/07 02:00〜15:30 と 10/08 03:10〜 の2回が計算範囲に入る。
  const points = [];
  for (let minutes = -12 * 60; minutes <= 36 * 60; minutes += 10) {
    const time = base + minutes * 60_000;
    const up = (time >= base + 2 * hour && time <= base + 15.5 * hour) ||
      time >= base + 27.17 * hour || time <= base - 9.5 * hour;
    points.push({ timestampMilliseconds: time, altitudeDegrees: up ? 20 : -20, inFront: true });
  }
  const track = { id: "moon", label: "月", points };
  const within = (selected, from, to) => selected.points.every((point) =>
    point.timestampMilliseconds >= base + from * hour && point.timestampMilliseconds <= base + to * hour);

  const during = selectCelestialTrackPass(track, base + 2.67 * hour); // 02:40
  assert.ok(during.points.length > 10 && within(during, 2, 15.5), "今日の通過だけ");
  const nextNight = selectCelestialTrackPass(track, base + 28 * hour);
  assert.ok(within(nextNight, 27, 36), "翌日の通過中は翌日の線");
  const beforeRise = selectCelestialTrackPass(track, base + 1 * hour); // 01:00、月の出前
  assert.ok(within(beforeRise, 2, 15.5), "沈んでいる間は時刻が最も近い通過");
  const afterSet = selectCelestialTrackPass(track, base + 16 * hour);
  assert.ok(within(afterSet, 2, 15.5));

  // 通過が1回だけ（太陽など）のときは何も変えない。
  const single = { id: "sun", label: "太陽", points: points.map((point) => ({ ...point, altitudeDegrees: 10 })) };
  assert.equal(selectCelestialTrackPass(single, base), single);
});

test("rise-set guide never turns into the search-limit circle when the reference ground is as high as the pin", () => {
  // 2026-10-08の報告を再現: 被写体ピン（楕円体高138.6m）と、約1km離れた丘の上の
  // 三脚ピン（地表137.1m）。レンズ高1.6mを足すと基準面が被写体ピンより高くなる。
  const subject = {
    latitude: 34.50888737, longitude: 135.6309602, height: 138.551,
    ellipsoidalHeightMeters: 138.551, label: "塔",
  };
  const base = {
    id: "moon",
    subject,
    dayStart: new Date("2026-10-06T15:00:00.000Z"),
    dayEnd: new Date("2026-10-07T15:00:00.000Z"),
    lensCenterHeightMeters: 1.6,
    calculationMode: "pro",
    maxDistanceMeters: 10_000,
  };
  const real = (arc) => arc.points.filter((point) => point.distanceMeters < 10_000);

  // 三脚ピンの高さしか基準が無い場合: 交点が存在しないので線を描かない（円にしない）。
  assert.equal(buildTripodCandidateRiseSetArc({ ...base, referenceGroundEllipsoidalHeightMeters: [137.1] }), null);

  // 被写体直下の地表（ピンの約24m下）が分かっていれば、それを基準に線ができる。
  const withSubjectGround = buildTripodCandidateRiseSetArc({
    ...base, referenceGroundEllipsoidalHeightMeters: [114.5, 137.1, 38.9],
  });
  assert.ok(withSubjectGround);
  assert.ok(real(withSubjectGround).length > 20);
  // 月の高度が約31度の04:48(JST)ごろ、候補は被写体から数十mの位置（診断の初期交点は63m）。
  const target = Date.parse("2026-10-06T19:48:00.000Z");
  const nearest = withSubjectGround.points.reduce((best, point) =>
    Math.abs(point.timestampMilliseconds - target) < Math.abs(best.timestampMilliseconds - target) ? point : best);
  assert.ok(nearest.distanceMeters > 20 && nearest.distanceMeters < 80, `distance ${nearest.distanceMeters}`);

  // 被写体直下の地表が未取得でも、三脚ピンで交点ができなければ次の基準（標高0m）へ進む。
  const fallback = buildTripodCandidateRiseSetArc({
    ...base, referenceGroundEllipsoidalHeightMeters: [137.1, 38.9],
  });
  assert.ok(fallback && real(fallback).length > 20);
  // 線の全点が円周上、ということは起きない。
  assert.ok(fallback.points.some((point) => point.distanceMeters < 1_000));
});

test("3D display speed tuning: tiles load while moving, MSAA is off, and the idle map is not redrawn every frame", async () => {
  const viewer = await readFile(new URL("../../src/cesium/createMapViewer.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const interaction = await readFile(
    new URL("../../src/cesium/interactive3dPerformance.ts", import.meta.url),
    "utf8"
  );
  assert.match(viewer, /tileset\.cullRequestsWhileMoving = false;\s*tileset\.foveatedTimeDelay = 0;/);
  assert.match(viewer, /viewer\.scene\.msaaSamples = 1;\s*viewer\.scene\.postProcessStages\.fxaa\.enabled = true;/);
  // Google 3D・標準3Dの両方のViewerと、Google・PLATEAUのタイルセットに適用する。
  assert.equal((viewer.match(/applyLightweightRendering\(viewer\);/g) ?? []).length, 2);
  assert.equal((viewer.match(/applyResponsiveTileLoading\((tileset|buildings)\);/g) ?? []).length, 3);
  // 画質（詳細度）の設定は変えていない。
  assert.match(viewer, /tileset\.maximumScreenSpaceError = 24;/);
  // 操作中は一時的に軽量化し、停止後に元の解像度とSSEへ必ず戻す。
  assert.match(interaction, /INTERACTION_RESOLUTION_SCALE = 0\.72/);
  assert.match(interaction, /viewer\.resolutionScale = normalResolutionScale/);
  assert.match(interaction, /tileset\.maximumScreenSpaceError = maximumScreenSpaceError/);
  // 描画呼び出し自体を操作・読込中30fps、静止中4fpsへ抑える。
  assert.match(app, /ACTIVE_RENDER_INTERVAL_MS = 1000 \/ 30/);
  assert.match(app, /IDLE_RENDER_INTERVAL_MS = 250/);
  assert.match(app, /sceneHasPending3dContent\(viewer\)/);
  assert.match(app, /if \(now - lastRenderAt >= interval\)[\s\S]*?viewer\.render\(\)/);
  // Google root待ちでも地理院地図を先に出し、最初のGoogle tileで切り替える。
  assert.match(viewer, /Googleタイルモード：地理院地図を表示しました。3Dデータを読み込み中/);
  assert.match(viewer, /tileset\.tileVisible\.addEventListener/);
  assert.match(viewer, /viewer\.scene\.globe\.show = false/);
});
