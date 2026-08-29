import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_SHARE_CODE_VERSION,
  decodeProjectShareCode,
  encodeProjectShareCode,
} from "../../src/sharing/projectShareCode.ts";

const payload = {
  name: "端末間一致テスト",
  shootingDateTimeLocal: "2026-08-29T03:18",
  timeZone: "Asia/Tokyo",
  subject: {
    latitude: 35.123456,
    longitude: 136.123456,
    height: 182.75,
    ellipsoidalHeightMeters: 182.75,
    orthometricHeightMeters: 145.25,
    geoidHeightMeters: 37.5,
    heightSource: "3d-picked",
    label: "塔頂",
  },
  tripod: {
    latitude: 35.12,
    longitude: 136.13,
    height: 48.125,
    ellipsoidalHeightMeters: 48.125,
    orthometricHeightMeters: 10.625,
    geoidHeightMeters: 37.5,
    heightSource: "dem",
    label: "確定三脚",
  },
  foregroundObjects: [],
  cameraSettings: { focalLengthMm: 554, lensCenterHeightMeters: 1.6 },
  celestialVisibility: { sun: true, moon: false, milkyWay: false, polaris: false },
  previewFrameMode: "landscape-3-2",
  viewCorrection: { azimuthDegrees: 0.35, altitudeDegrees: -0.2 },
  precisionSettings: {
    accuracyMode: "standard",
    refractionCorrectionMode: "standard",
    tripodCandidateDoubleCheckEnabled: false,
  },
};

test("project share V2 preserves exact subject/tripod height bases and view correction across devices", () => {
  assert.equal(PROJECT_SHARE_CODE_VERSION, 2);
  const code = encodeProjectShareCode(payload);
  const pc = decodeProjectShareCode(code);
  const phone = decodeProjectShareCode(code);

  assert.equal(pc.v, 2);
  assert.deepEqual(phone, pc);
  assert.deepEqual(pc.subject, payload.subject);
  assert.deepEqual(pc.tripod, payload.tripod);
  assert.deepEqual(pc.viewCorrection, payload.viewCorrection);
  assert.deepEqual(pc.precisionSettings, payload.precisionSettings);
});

test("legacy V1 share codes remain readable but are explicitly distinguishable", () => {
  const legacy = {
    v: 1,
    name: payload.name,
    shootingDateTimeLocal: payload.shootingDateTimeLocal,
    timeZone: payload.timeZone,
    subject: { latitude: payload.subject.latitude, longitude: payload.subject.longitude, label: payload.subject.label },
    tripod: { latitude: payload.tripod.latitude, longitude: payload.tripod.longitude, label: payload.tripod.label },
    foregroundObjects: [],
    cameraSettings: payload.cameraSettings,
    celestialVisibility: payload.celestialVisibility,
    previewFrameMode: payload.previewFrameMode,
  };
  const base64 = Buffer.from(JSON.stringify(legacy), "utf8").toString("base64");
  const code = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = decodeProjectShareCode(code);
  assert.equal(decoded.v, 1);
  assert.equal("height" in decoded.subject, false);
});
