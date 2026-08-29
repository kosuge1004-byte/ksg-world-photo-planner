import type { CameraSettings, CameraViewCorrection, PreviewFrameMode } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { ForegroundObjectType } from "../types/foreground";
import type { GroundPoint } from "../types/points";
import type { PrecisionSettings } from "../types/precision";

/**
 * 共有URLに載せるプロジェクトの中身。
 *
 * V2は、塔頂・屋上・3Dピックとround-trip検証済み三脚の完全な高さ基準を
 * 共有する。受信端末でDEMを取り直すと建物頂上が地面へ落ちたり、端末ごとの
 * DEM応答差で同一プロジェクトが別結果になるためである。旧V1のみ互換読込時に
 * 高さを受信端末で解決する。
 */
export const PROJECT_SHARE_CODE_VERSION = 2;

export type SharedForegroundObject = {
  type: ForegroundObjectType;
  latitude: number;
  longitude: number;
  heightCm: number;
  enabled: boolean;
};

export type SharedProjectPayloadV1 = {
  v: 1;
  name: string;
  shootingDateTimeLocal: string;
  timeZone: string;
  subject: { latitude: number; longitude: number; label: string };
  tripod: { latitude: number; longitude: number; label: string };
  foregroundObjects: SharedForegroundObject[];
  cameraSettings: CameraSettings;
  celestialVisibility: CelestialVisibility;
  previewFrameMode: PreviewFrameMode;
};

export type SharedProjectPayloadV2 = {
  v: 2;
  name: string;
  shootingDateTimeLocal: string;
  timeZone: string;
  /** 塔頂・屋上・3Dピックを含む確定3D座標を端末間で同一に保つ。 */
  subject: GroundPoint;
  /** round-trip検証済みの三脚高さを端末間で同一に保つ。 */
  tripod: GroundPoint;
  foregroundObjects: SharedForegroundObject[];
  cameraSettings: CameraSettings;
  celestialVisibility: CelestialVisibility;
  previewFrameMode: PreviewFrameMode;
  viewCorrection: CameraViewCorrection;
  precisionSettings: PrecisionSettings;
};

export type SharedProjectPayload = SharedProjectPayloadV1 | SharedProjectPayloadV2;

export class ProjectShareCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectShareCodeError";
  }
}

function toBase64Url(text: string): string {
  const base64 = btoa(unescape(encodeURIComponent(text)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): string {
  const base64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

/** 現在の撮影計画を共有コード（URLのhashにそのまま載せられる文字列）へ変換する。 */
export function encodeProjectShareCode(payload: Omit<SharedProjectPayloadV2, "v">): string {
  const full: SharedProjectPayloadV2 = { v: PROJECT_SHARE_CODE_VERSION, ...payload };
  return toBase64Url(JSON.stringify(full));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertPoint(value: unknown, label: string): asserts value is { latitude: number; longitude: number; label: string } {
  const point = value as { latitude?: unknown; longitude?: unknown; label?: unknown } | null;
  if (
    !point ||
    !isFiniteNumber(point.latitude) || point.latitude < -90 || point.latitude > 90 ||
    !isFiniteNumber(point.longitude) || point.longitude < -180 || point.longitude > 180 ||
    typeof point.label !== "string"
  ) {
    throw new ProjectShareCodeError(`共有リンクの${label}の座標が不正です`);
  }
}

function assertGroundPoint(value: unknown, label: string): asserts value is GroundPoint {
  assertPoint(value, label);
  const point = value as Partial<GroundPoint>;
  if (!isFiniteNumber(point.height)) {
    throw new ProjectShareCodeError(`共有リンクの${label}の高さが不正です`);
  }
  for (const height of [
    point.ellipsoidalHeightMeters,
    point.orthometricHeightMeters,
    point.geoidHeightMeters,
  ]) {
    if (height !== undefined && !isFiniteNumber(height)) {
      throw new ProjectShareCodeError(`共有リンクの${label}の高さ基準が不正です`);
    }
  }
}

/**
 * 共有コードを検証しながら復号する。壊れたリンク・未対応バージョンは
 * 例外にする（部分的に読み込んで先へ進めない）。
 */
export function decodeProjectShareCode(code: string): SharedProjectPayload {
  let json: string;
  try {
    json = fromBase64Url(code);
  } catch {
    throw new ProjectShareCodeError("共有リンクを読み取れませんでした。リンクが途中で切れている可能性があります");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProjectShareCodeError("共有リンクの内容を解釈できませんでした");
  }
  const value = parsed as Partial<SharedProjectPayloadV1> | Partial<SharedProjectPayloadV2> | null;
  if (!value || typeof value !== "object") {
    throw new ProjectShareCodeError("共有リンクの内容が不正です");
  }
  if (value.v !== 1 && value.v !== 2) {
    throw new ProjectShareCodeError(
      "このリンクは対応していないバージョンの撮影計画です。アプリを最新にしてから開いてください"
    );
  }
  assertPoint(value.subject, "被写体");
  assertPoint(value.tripod, "三脚");
  if (value.v === 2) {
    assertGroundPoint(value.subject, "被写体");
    assertGroundPoint(value.tripod, "三脚");
    if (
      !value.viewCorrection ||
      !isFiniteNumber(value.viewCorrection.azimuthDegrees) ||
      !isFiniteNumber(value.viewCorrection.altitudeDegrees)
    ) {
      throw new ProjectShareCodeError("共有リンクの構図補正が不正です");
    }
    if (
      !value.precisionSettings ||
      (value.precisionSettings.accuracyMode !== "standard" && value.precisionSettings.accuracyMode !== "highest") ||
      (value.precisionSettings.refractionCorrectionMode !== "standard" && value.precisionSettings.refractionCorrectionMode !== "auto") ||
      typeof value.precisionSettings.tripodCandidateDoubleCheckEnabled !== "boolean"
    ) {
      throw new ProjectShareCodeError("共有リンクの精度設定が不正です");
    }
  }
  if (!Array.isArray(value.foregroundObjects)) {
    throw new ProjectShareCodeError("共有リンクの人物・前景情報が不正です");
  }
  for (const object of value.foregroundObjects) {
    if (
      !isFiniteNumber(object?.latitude) || !isFiniteNumber(object?.longitude) ||
      !isFiniteNumber(object?.heightCm) || typeof object?.enabled !== "boolean"
    ) {
      throw new ProjectShareCodeError("共有リンクの人物・前景情報が不正です");
    }
  }
  if (
    typeof value.name !== "string" ||
    typeof value.shootingDateTimeLocal !== "string" ||
    typeof value.timeZone !== "string" ||
    !value.cameraSettings || !isFiniteNumber(value.cameraSettings.focalLengthMm) ||
    !isFiniteNumber(value.cameraSettings.lensCenterHeightMeters) ||
    !value.celestialVisibility ||
    !value.previewFrameMode
  ) {
    throw new ProjectShareCodeError("共有リンクの内容が不正です");
  }
  return value as SharedProjectPayload;
}
