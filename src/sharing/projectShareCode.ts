import type { CameraSettings, PreviewFrameMode } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { ForegroundObjectType } from "../types/foreground";

/**
 * 共有URLに載せるプロジェクトの中身。
 *
 * 緯度経度・カメラ設定・表示設定だけを含み、高度（ellipsoidalHeightMeters /
 * orthometricHeightMeters / geoidHeightMeters / height）は一切含めない。
 * 送信側の環境（DEM取得タイミング・3Dピック結果）を無条件に信頼すると
 * 標高と楕円体高の混在や、地形データ更新後の食い違いにつながるため、
 * 高度は受信側でHeightResolverを通して必ず取り直す（0mフォールバックはしない）。
 */
export const PROJECT_SHARE_CODE_VERSION = 1;

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
export function encodeProjectShareCode(payload: Omit<SharedProjectPayloadV1, "v">): string {
  const full: SharedProjectPayloadV1 = { v: PROJECT_SHARE_CODE_VERSION, ...payload };
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

/**
 * 共有コードを検証しながら復号する。壊れたリンク・未対応バージョンは
 * 例外にする（部分的に読み込んで先へ進めない）。
 */
export function decodeProjectShareCode(code: string): SharedProjectPayloadV1 {
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
  const value = parsed as Partial<SharedProjectPayloadV1> | null;
  if (!value || typeof value !== "object") {
    throw new ProjectShareCodeError("共有リンクの内容が不正です");
  }
  if (value.v !== 1) {
    throw new ProjectShareCodeError(
      "このリンクは対応していないバージョンの撮影計画です。アプリを最新にしてから開いてください"
    );
  }
  assertPoint(value.subject, "被写体");
  assertPoint(value.tripod, "三脚");
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
  return value as SharedProjectPayloadV1;
}
