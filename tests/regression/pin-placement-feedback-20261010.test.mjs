// 2026-10-10: ピンを置く操作の待ち時間と表示。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("a provisional pin is shown at the tapped place until the height is resolved; the real pin still waits for the height", async () => {
  const app = await read("src/App.tsx");
  const overlay = await read("src/components/Map2DOverlay.tsx");
  const css = await read("src/App.css");
  // 直接タップの三脚: 仮のピンを出してから高さを取得し、終わったら（成功・失敗とも）消す。
  assert.match(app, /setDirectTapPendingPin\(pending\);[\s\S]*?await setTripodPinFromCoordinates\([\s\S]*?setTripodPoint\(point\);[\s\S]*?finally \{[\s\S]*?setDirectTapPendingPin\(\(current\) => \(current === pending \? null : current\)\);/);
  // 計算に使う三脚ピンは、高さが確定してから置く（仮のピンの座標を計算へ渡さない）。
  assert.doesNotMatch(app, /setTripodPoint\(pending|setSubjectPoint\(pending|setTripodPoint\(directTapPendingPin/);
  // 配置モード（確認ダイアログあり）: タップした座標を渡し、確定・キャンセルまで仮のピンを出す。
  assert.equal((app.match(/\}, coordinates\);/g) ?? []).length, 2);
  assert.match(app, /if \(pendingPlacement\?\.coordinates && pendingPlacement\.kind !== "person"\)/);
  assert.match(app, /pendingPin=\{pendingPin2d\}/);
  assert.match(overlay, /className=\{`map-2d-pin map-2d-pending-pin /);
  assert.match(css, /\.map-2d-pending-pin \{[^}]*opacity: \.6;/);
});

test("the placement dialog never shows internal error text", async () => {
  const app = await read("src/App.tsx");
  assert.match(app, /\(error instanceof HeightResolutionError \|\| error instanceof ValidationError\) && error\.message/);
});

test("saved spots: the OSM lookup is not awaited when the measured roof already decides the height", async () => {
  const app = await read("src/App.tsx");
  // 3つの取得は同時に開始し、待つのは地面と屋根。屋根だけで決まる場合に限りOSMを待たない。
  assert.match(app, /const \[groundPoint, firstRoofPoint\] = await Promise\.all\(\[\s*groundPointPromise,\s*roofPointPromise,\s*\]\);/);
  assert.match(app, /if \(!surfaceHint\.dynamicHeightPriority \|\| !firstRoofPoint\) return false;/);
  assert.match(app, /const osmInspection = roofDecidesAlone\s*\? \{ isStructure: false, heightHint: null \}\s*: await osmInspectionPromise;/);
});
