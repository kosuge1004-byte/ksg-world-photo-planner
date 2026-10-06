// 2026-10-07: 起動時に「前回終了時の表示」を復元するための保存データ。
// 地図（中心・ズーム・種別・2D/3D）、カメラ設定、表示天体は以前から個別に保存・復元されている。
// ここでは残りの、日時・タイムゾーン・被写体ピン・三脚ピンを扱う。
//
// - 日時は従来から "ksg-celestial-datetime" へ保存されていた（復元だけしていなかった）ので、
//   そのキーをそのまま読む。
// - ピンとタイムゾーンは "astrosight-last-session-v1" へ保存する。
// - 壊れた値・範囲外の値は捨て、その項目だけ従来の初期値（現在日時・ピンなし）に戻す。

import type { GroundPoint } from "../types/points";
import { isValidTimeZone } from "../time/zonedTime";

const DATETIME_STORAGE_KEY = "ksg-celestial-datetime";
const SESSION_STORAGE_KEY = "astrosight-last-session-v1";

export type LastSession = {
  dateTimeLocal: string | null;
  timeZone: string | null;
  subject: GroundPoint | null;
  tripod: GroundPoint | null;
};

function validPoint(value: unknown): GroundPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const point = value as Partial<GroundPoint>;
  if (
    typeof point.latitude !== "number" || !Number.isFinite(point.latitude) ||
    point.latitude < -90 || point.latitude > 90 ||
    typeof point.longitude !== "number" || !Number.isFinite(point.longitude) ||
    point.longitude < -180 || point.longitude > 180 ||
    typeof point.height !== "number" || !Number.isFinite(point.height) ||
    point.height < -1_000 || point.height > 10_000
  ) return null;
  return { ...(point as GroundPoint), label: typeof point.label === "string" ? point.label : "" };
}

/** 保存文字列から復元内容を作る（テストしやすいよう localStorage から分離）。 */
export function parseLastSession(
  dateTimeText: string | null,
  sessionText: string | null
): LastSession {
  const session: LastSession = { dateTimeLocal: null, timeZone: null, subject: null, tripod: null };
  if (dateTimeText && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTimeText)) {
    const [year, month, day, hour, minute] = dateTimeText.split(/[-T:]/).map(Number);
    if (
      year >= 1900 && year <= 2100 && month >= 1 && month <= 12 &&
      day >= 1 && day <= 31 && hour <= 23 && minute <= 59
    ) session.dateTimeLocal = dateTimeText;
  }
  if (!sessionText) return session;
  try {
    const parsed = JSON.parse(sessionText) as Record<string, unknown>;
    if (typeof parsed.timeZone === "string" && isValidTimeZone(parsed.timeZone)) {
      session.timeZone = parsed.timeZone;
    }
    session.subject = validPoint(parsed.subject);
    session.tripod = validPoint(parsed.tripod);
  } catch {
    // 壊れた保存値は使わない
  }
  // 日時はタイムゾーンと組でないと別の瞬間を指してしまう。
  // タイムゾーンが保存されていない旧データでは、日時は端末のタイムゾーンで解釈される。
  return session;
}

let cached: LastSession | null = null;

/** 起動時に1回だけ読む。以降は同じ内容を返す（初期値の計算が複数箇所から呼ぶため）。 */
export function loadLastSession(): LastSession {
  if (cached) return cached;
  try {
    cached = parseLastSession(
      localStorage.getItem(DATETIME_STORAGE_KEY),
      localStorage.getItem(SESSION_STORAGE_KEY)
    );
  } catch {
    cached = { dateTimeLocal: null, timeZone: null, subject: null, tripod: null };
  }
  return cached;
}

export function saveLastSessionPins(
  timeZone: string,
  subject: GroundPoint | null,
  tripod: GroundPoint | null
): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ timeZone, subject, tripod }));
  } catch {
    // 保存できなくても今回の表示には影響しない
  }
}
