import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.window ??= {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

let directElevationCalls = 0;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "/api/bearing-profile-batch") {
    return new Response("<!doctype html><title>AstroSight</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (url.includes("/api/gsi-elevation")) {
    directElevationCalls += 1;
  }
  throw new Error(`unexpected direct request: ${url}`);
};

const { backfillBearingProfiles } = await import(
  "../../src/cache/tripodBearingProfileManager.ts"
);

test("registered profile HTML response never starts the hour-long direct path", async () => {
  await assert.rejects(
    backfillBearingProfiles({
      subjectId: "registered-html-error",
      subjectPoint: {
        latitude: 35.7100627,
        longitude: 139.8107004,
        height: 672,
        label: "東京スカイツリー",
      },
      cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
      maxDistanceMeters: 10_000,
    }),
    {
      name: "PrecomputedBearingProfileUnavailableError",
    }
  );
  assert.equal(directElevationCalls, 0);
});

test("arbitrary nearby coordinates also never start the hour-long direct path", async () => {
  await assert.rejects(
    backfillBearingProfiles({
      subjectId: "nearby-html-error",
      subjectPoint: {
        latitude: 35.7101127,
        longitude: 139.8107504,
        height: 12,
        label: "押上の任意地点",
      },
      cameraSettings: { focalLengthMm: 200, lensCenterHeightMeters: 1.6 },
      maxDistanceMeters: 10_000,
    }),
    { name: "PrecomputedBearingProfileUnavailableError" }
  );
  assert.equal(directElevationCalls, 0);
});
