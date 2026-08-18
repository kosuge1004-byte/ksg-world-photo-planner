import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters, orthometricHeightMeters } from "../types/points";

/**
 * ValidationService: 精度計算に入る値の検証を一本化する唯一の場所。
 *
 * 方針:
 * - NaN / Infinity は 0m や 0度へフォールバックせず、必ず例外にする。
 * - 高度取得失敗は計算停止であり、暫定値で先へ進めない。
 * - 例外メッセージはユーザー通知にそのまま使える日本語にする。
 */
export class ValidationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.cause = cause;
  }
}

/** NaN / Infinity を禁止する基本検証。全ての数値検証はここを通る。 */
export function assertFinite(value: unknown, valueName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${valueName}が数値として不正です（NaNまたは無限大）`);
  }
}

function assertRange(
  value: unknown,
  valueName: string,
  minimum: number,
  maximum: number,
  unit: string
): asserts value is number {
  assertFinite(value, valueName);
  const numeric = value as number;
  if (numeric < minimum || numeric > maximum) {
    throw new ValidationError(
      `${valueName}は${minimum}〜${maximum}${unit}の範囲でなければなりません（現在値 ${numeric}${unit}）`
    );
  }
}

export function assertLatitude(value: unknown, valueName = "緯度"): asserts value is number {
  assertRange(value, valueName, -90, 90, "度");
}

export function assertLongitude(value: unknown, valueName = "経度"): asserts value is number {
  assertRange(value, valueName, -180, 180, "度");
}

/**
 * 高度の検証。マリアナ海溝(-11km)〜成層圏(100km)を超える値は
 * DEM/ジオイド/3Dピックいずれかの異常とみなす。
 */
export function assertHeightMeters(value: unknown, valueName = "高度"): asserts value is number {
  assertRange(value, valueName, -11_000, 100_000, "m");
}

/** 方位角。0〜360度に収まっていることを要求する（正規化は呼び出し側の責務）。 */
export function assertBearingDegrees(value: unknown, valueName = "方位角"): asserts value is number {
  assertRange(value, valueName, 0, 360, "度");
}

/** 方位角の別名。天体側の呼称に合わせる。 */
export function assertAzimuthDegrees(value: unknown, valueName = "方位角"): asserts value is number {
  assertBearingDegrees(value, valueName);
}

/** 仰角・ピッチ。天底-90度〜天頂+90度。 */
export function assertPitchDegrees(value: unknown, valueName = "仰角"): asserts value is number {
  assertRange(value, valueName, -90, 90, "度");
}

/** 仰角の別名。 */
export function assertAltitudeDegrees(value: unknown, valueName = "高度角"): asserts value is number {
  assertPitchDegrees(value, valueName);
}

export function assertRollDegrees(value: unknown, valueName = "ロール角"): asserts value is number {
  assertRange(value, valueName, -180, 180, "度");
}

/** 画角。0度超〜180度未満（ピンホール投影が発散しない範囲）。 */
export function assertFovDegrees(value: unknown, valueName = "画角"): asserts value is number {
  assertFinite(value, valueName);
  const numeric = value as number;
  if (numeric <= 0 || numeric >= 180) {
    throw new ValidationError(
      `${valueName}は0度より大きく180度未満でなければなりません（現在値 ${numeric}度）`
    );
  }
}

/** 距離。負の距離は測地線計算の異常。 */
export function assertDistanceMeters(value: unknown, valueName = "距離"): asserts value is number {
  assertFinite(value, valueName);
  if ((value as number) < 0) {
    throw new ValidationError(`${valueName}が負の値です（現在値 ${value as number}m）`);
  }
}

/** ECEF座標(x,y,z)。地球中心からの距離が現実的な範囲にあることも確認する。 */
export function assertEcefPosition(
  position: { x: number; y: number; z: number },
  valueName = "ECEF座標"
): void {
  assertFinite(position?.x, `${valueName}のX成分`);
  assertFinite(position?.y, `${valueName}のY成分`);
  assertFinite(position?.z, `${valueName}のZ成分`);
  const radius = Math.hypot(position.x, position.y, position.z);
  // 地球中心から極半径-11km 〜 赤道半径+100km の範囲を許容する。
  if (radius < 6_345_000 || radius > 6_479_000) {
    throw new ValidationError(
      `${valueName}が地球表面付近にありません（地心距離 ${Math.round(radius)}m）`
    );
  }
}

/**
 * 計算に投入する直前のGroundPointを検証する。
 * 楕円体高・標高の両方が取得済みで有限であることを要求し、
 * 高度未確定のまま計算経路へ入ることを防ぐ。
 */
export function assertGroundPoint(point: GroundPoint, valueName?: string): void {
  const label = valueName ?? point?.label ?? "地点";
  if (!point) throw new ValidationError(`${label}が未設定です`);
  assertLatitude(point.latitude, `${label}の緯度`);
  assertLongitude(point.longitude, `${label}の経度`);
  // ellipsoidalHeightMeters()/orthometricHeightMeters()は未確定時に例外を投げるため、
  // ValidationErrorへ包み直して統一したユーザー通知にする。
  let ellipsoidal: number;
  let orthometric: number;
  try {
    ellipsoidal = ellipsoidalHeightMeters(point);
    orthometric = orthometricHeightMeters(point);
  } catch (error) {
    throw new ValidationError(`${label}の高度を確定できていません`, error);
  }
  assertHeightMeters(ellipsoidal, `${label}の楕円体高`);
  assertHeightMeters(orthometric, `${label}の標高`);
}

/**
 * 高度取得に失敗した場合のユーザー通知用メッセージ。
 * 0mフォールバックは全面禁止のため、必ず「計算を停止した」ことを伝える。
 */
export function heightResolutionFailureMessage(label: string): string {
  return `${label}の高度を取得できないため計算を中止しました。通信状態を確認して再試行してください。`;
}
