import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("hamburger menu opens one exclusive display guide and closes it with every other detail panel", () => {
  const topBar = read("src/components/TopSettingsBar.tsx");
  assert.match(topBar, /import \{ DisplayGuide \} from "\.\/DisplayGuide"/);
  assert.match(topBar, /const \[displayGuideOpen, setDisplayGuideOpen\] = useState\(false\)/);
  assert.match(topBar, /setDisplayGuideOpen\(false\)/);
  assert.match(topBar, /panel: "precision" \| "3d" \| "light" \| "sources" \| "display"/);
  assert.match(topBar, /panel === "display" \? !displayGuideOpen : false/);
  assert.match(topBar, /<b>表示の説明<\/b><small>線・点・ピン・画面操作の見方<\/small>/);
  assert.match(topBar, /<DisplayGuide onClose=\{\(\) => setDisplayGuideOpen\(false\)\} \/>/);
});

test("display guide covers every main-screen visual family and distinguishes exact, provisional and verified results", () => {
  const guide = read("src/components/DisplayGuide.tsx");
  const required = [
    "黄橙の破線（太陽）",
    "水色の破線（月）",
    "薄白／桃紫の破線（天の川）",
    "紫の破線（北極星）",
    "赤の細い実線（三脚候補線・確定）",
    "赤の細い破線（三脚候補線・目安）",
    "白の破線（3D地図のみ）",
    "緑の小点（見通し確認済み）",
    "遮蔽あり・未確認・判定不能の点は緑で表示しません",
    "赤いピン（被写体）",
    "青いピン（三脚）",
    "半透明で点滅するピン",
    "人物マーカー",
    "黄色の軌跡と時刻",
    "青い破線と両端の点",
    "時間軸",
    "2D・3D地図の操作",
    "◎ 見通し",
    "2つを裏で同時に動かす切替ではありません",
    "画面上部の共通設定",
  ];
  for (const text of required) {
    assert.ok(guide.includes(text), `display guide is missing: ${text}`);
  }
});

test("the guide and 3D settings state the current DEM plus PLATEAU visibility path without claiming Google geometry is calculated", () => {
  const guide = read("src/components/DisplayGuide.tsx");
  const topBar = read("src/components/TopSettingsBar.tsx");
  assert.match(guide, /「◎ 見通し」はDEM地形とPLATEAU建物を使用します/);
  assert.match(topBar, /「見通し」確認はDEM地形とPLATEAU建物を使います/);
  assert.match(topBar, /Google建物3Dは表示専用です/);
  assert.doesNotMatch(topBar, /遮蔽判定には使いません（DEM地形のみで判定します）/);
});

test("display guide has mobile-readable sections and visual samples", () => {
  const styles = read("src/App.css");
  for (const selector of [
    ".display-guide {",
    ".display-guide-section {",
    ".display-guide-row {",
    ".display-guide-sample.line-candidate-exact::before",
    ".display-guide-sample.dot-visible::before",
    ".display-guide-sample.pin-tripod::before",
    ".display-guide-sample.timeline",
  ]) {
    assert.ok(styles.includes(selector), `display guide style is missing: ${selector}`);
  }
});
