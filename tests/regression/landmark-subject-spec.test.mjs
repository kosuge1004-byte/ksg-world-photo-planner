import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { JAPAN_LANDMARKS } from "../../src/data/japanLandmarks.ts";
import { PREWARM_LANDMARKS } from "../../server/landmarkPrewarmSeed.ts";
import {
  LANDMARK_STRUCTURE_HEIGHT_MAX_METERS,
  LANDMARK_STRUCTURE_HEIGHT_MIN_METERS,
} from "../../src/types/landmarkSubjectSpec.ts";

const allowlist = new Set(JSON.parse(fs.readFileSync(
  new URL("./fixtures/landmark-height-unverified-allowlist.json", import.meta.url), "utf8"
)).names);

// 分類ごとに取り得る被写体仕様。城・寺社・自然は現存構造物か跡地/地形かで両方あり得る。
const REQUIRED_SURFACE_BY_CATEGORY = {
  mountain: "terrain",
  themepark: "terrain",
  tower: "structure",
  building: "structure",
  ferriswheel: "structure",
  rollercoaster: "structure",
};

function specOf(landmark) {
  return JSON.stringify({
    name: landmark.name, category: landmark.category,
    latitude: landmark.latitude, longitude: landmark.longitude,
    subjectSurface: landmark.subjectSurface, heightMeters: landmark.heightMeters,
    heightStatus: landmark.heightStatus ?? null,
  });
}

for (const [label, catalogue] of [["client", JAPAN_LANDMARKS], ["server seed", PREWARM_LANDMARKS]]) {
  test(`${label}: every landmark states where the subject sits and how high`, () => {
    for (const landmark of catalogue) {
      const where = `${landmark.name}`;
      assert.ok(landmark.subjectSurface === "terrain" || landmark.subjectSurface === "structure",
        `${where}: subjectSurface must be terrain or structure`);
      if (landmark.subjectSurface === "terrain") {
        assert.equal(landmark.heightMeters, 0, `${where}: terrain must be heightMeters 0`);
        assert.equal(landmark.heightStatus, undefined, `${where}: terrain cannot be unverified`);
      } else if (landmark.heightMeters === null) {
        assert.equal(landmark.heightStatus, "unverified", `${where}: null height needs heightStatus`);
        assert.ok(allowlist.has(landmark.name),
          `${where}: 新規・変更した構造物は高さ(m)の明記が必須です（未確認リストへの追加は不可）`);
      } else {
        assert.ok(Number.isFinite(landmark.heightMeters) &&
          landmark.heightMeters >= LANDMARK_STRUCTURE_HEIGHT_MIN_METERS &&
          landmark.heightMeters <= LANDMARK_STRUCTURE_HEIGHT_MAX_METERS,
          `${where}: structure height ${landmark.heightMeters} is outside ${LANDMARK_STRUCTURE_HEIGHT_MIN_METERS}-${LANDMARK_STRUCTURE_HEIGHT_MAX_METERS} m`);
        assert.equal(landmark.heightStatus, undefined, `${where}: verified height cannot be unverified`);
      }
      const required = REQUIRED_SURFACE_BY_CATEGORY[landmark.category];
      if (required) assert.equal(landmark.subjectSurface, required, `${where}: ${landmark.category} must be ${required}`);
    }
  });
}

test("client catalogue and server seed are identical (names, coordinates, subject spec)", () => {
  assert.deepEqual(JAPAN_LANDMARKS.map(specOf), PREWARM_LANDMARKS.map(specOf));
  assert.equal(new Set(JAPAN_LANDMARKS.map((landmark) => landmark.name)).size, JAPAN_LANDMARKS.length);
});

test("unverified allowlist only shrinks: every listed name still exists and is still unverified", () => {
  const unverified = new Set(JAPAN_LANDMARKS
    .filter((landmark) => landmark.heightStatus === "unverified")
    .map((landmark) => landmark.name));
  for (const name of allowlist) {
    assert.ok(unverified.has(name),
      `${name} は解決済みです。fixtures/landmark-height-unverified-allowlist.json から削除してください`);
  }
});

test("registered spots without published precomputed data fall back (404) instead of failing (503)", async () => {
  const { PRECOMPUTED_BEARING_PROFILE_TARGETS } = await import("../../server/precomputedBearingProfileTargets.ts");
  const endpoint = fs.readFileSync(new URL("../../functions/api/bearing-profile-batch.ts", import.meta.url), "utf8");
  assert.match(endpoint, /PRECOMPUTED_BEARING_PROFILE_TARGETS\.some/u);
  assert.doesNotMatch(endpoint, /ACTIVE_PREWARM_LANDMARKS/u);
  const published = new Set(PRECOMPUTED_BEARING_PROFILE_TARGETS.map((target) => target.name));
  assert.equal(published.has("スチールドラゴン2000"), false);
  assert.ok(JAPAN_LANDMARKS.some((landmark) => landmark.name === "スチールドラゴン2000"));
});
