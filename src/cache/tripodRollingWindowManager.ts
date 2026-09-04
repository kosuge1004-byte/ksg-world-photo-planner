import { calculateCelestialHorizontalCoordinates, findHorizonCrossing } from "../cesium/celestial";
import { calculateTripodCandidates } from "../cesium/tripodCandidates";
import { withLensCenterHeight, type GroundPoint } from "../types/points";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";
import {
  getRollingWindowDay,
  setRollingWindowEntry,
  clearRollingWindowCacheForSubject,
  type RollingWindowEventKey,
} from "./tripodRollingWindowCache";

/**
 * 2026-09-04追記: お気に入り被写体の「ローリングウィンドウ」事前計算。
 *
 * 会話で詰めた設計:
 * - 1年分を一度に確定させず、常に「今日から先N日」だけを保持するローリング
 *   方式（初回の待ち時間を抑えつつ、時間経過とともに自動で先を継ぎ足す）。
 * - 対象イベントは日の出没・月の出没（1日最大4件）。findHorizonCrossing
 *   （celestial.tsへ切り出し済み）で通信不要に日時を求め、その日時ぶんだけ
 *   calculateTripodCandidates（通常検索と全く同じ、正規のフル計算経路）を
 *   呼ぶ。端末側での再解釈・再補間は一切行わない。
 * - 焦点距離はキャッシュキーに含めない（計算に使われていないため）。
 *   カメラ高が変わった場合は自然にキャッシュキーが変わり、再計算される。
 */

/**
 * 2026-09-04追記: お気に入り被写体の周辺データ事前計算。
 *
 * 当初は「常に今日から60日だけ保持し、自動で先を継ぎ足す」ローリング方式
 * だったが、「期間指定」と「全部（1年）」の2択で十分、という指摘を反映し、
 * ダウンロード時にユーザーが期間を選ぶ方式に変更した。選んだ期間はお気に
 * 入りごとに記憶し、以後はその期間を保ったまま「今日から先」を自動で
 * 継ぎ足す（削除は行わない。詳しくはtripodRollingWindowCache.tsのTTL参照）。
 *
 * - 対象イベントは日の出没・月の出没（1日最大4件）。findHorizonCrossing
 *   （celestial.tsへ切り出し済み）で通信不要に日時を求め、その日時ぶんだけ
 *   calculateTripodCandidates（通常検索と全く同じ、正規のフル計算経路）を
 *   呼ぶ。端末側での再解釈・再補間は一切行わない。
 * - 焦点距離はキャッシュキーに含めない（計算に使われていないため）。
 *   カメラ高が変わった場合は自然にキャッシュキーが変わり、再計算される。
 */

/** 「全部」＝1年ぶん。 */
export const ROLLING_WINDOW_MAX_DAYS = 365;
/** ダイアログで選べる期間の選択肢（最後の値がROLLING_WINDOW_MAX_DAYSと一致）。 */
export const ROLLING_WINDOW_PERIOD_OPTIONS = [30, 90, 180, ROLLING_WINDOW_MAX_DAYS] as const;
const DEFAULT_ROLLING_WINDOW_DAYS = 90;

const OPT_IN_STORAGE_KEY = "ksg-tripod-rolling-window-subjects-v1";

export type RollingWindowOptIn = {
  subjectId: string;
  label: string;
  /** ユーザーが選んだ期間（日数）。以後この日数を保ったまま自動で継ぎ足す。 */
  windowDays: number;
  enabledAtIso: string;
};

function readOptIns(): RollingWindowOptIn[] {
  try {
    const raw = localStorage.getItem(OPT_IN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // windowDays導入前に保存された旧データ（フィールド無し）を安全に補完する。
    return parsed.map((item) => ({
      ...item,
      windowDays: Number.isFinite(item?.windowDays) ? item.windowDays : DEFAULT_ROLLING_WINDOW_DAYS,
    }));
  } catch {
    return [];
  }
}

function writeOptIns(records: RollingWindowOptIn[]): RollingWindowOptIn[] {
  localStorage.setItem(OPT_IN_STORAGE_KEY, JSON.stringify(records));
  return records;
}

export function listRollingWindowOptIns(): RollingWindowOptIn[] {
  return readOptIns();
}

export function isRollingWindowEnabled(subjectId: string): boolean {
  return readOptIns().some((item) => item.subjectId === subjectId);
}

export function getRollingWindowDays(subjectId: string): number {
  return readOptIns().find((item) => item.subjectId === subjectId)?.windowDays
    ?? DEFAULT_ROLLING_WINDOW_DAYS;
}

export function enableRollingWindow(subjectId: string, label: string, windowDays: number): void {
  const current = readOptIns().filter((item) => item.subjectId !== subjectId);
  writeOptIns([
    { subjectId, label, windowDays, enabledAtIso: new Date().toISOString() },
    ...current,
  ]);
}

export async function disableRollingWindow(subjectId: string): Promise<void> {
  writeOptIns(readOptIns().filter((item) => item.subjectId !== subjectId));
  // お気に入り自体を消したわけではなく機能をOFFにしただけの場合でも、
  // 古いキャッシュを端末に残し続ける理由はないため合わせて削除する。
  await clearRollingWindowCacheForSubject(subjectId);
}

export type RollingWindowProgress = {
  totalSteps: number;
  completedSteps: number;
  currentDateText: string | null;
};

function buildCelestialPoint(
  id: "sun" | "moon",
  label: string,
  date: Date,
  observer: GroundPoint,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): CelestialScreenPoint {
  return {
    id,
    label,
    ...calculateCelestialHorizontalCoordinates(id, date, observer, calculationMode, refractionWeather),
    xPercent: 50,
    yPercent: 50,
    inFront: true,
    visibleInFrame: false,
  };
}

const EVENT_DEFINITIONS: Array<{
  eventKey: RollingWindowEventKey;
  bodyId: "sun" | "moon";
  bodyLabel: string;
  direction: 1 | -1;
}> = [
  { eventKey: "sunrise", bodyId: "sun", bodyLabel: "太陽", direction: 1 },
  { eventKey: "sunset", bodyId: "sun", bodyLabel: "太陽", direction: -1 },
  { eventKey: "moonrise", bodyId: "moon", bodyLabel: "月", direction: 1 },
  { eventKey: "moonset", bodyId: "moon", bodyLabel: "月", direction: -1 },
];

/**
 * 今日から windowDays 日ぶんの日付のうち、まだ4イベント全部が
 * キャッシュされていない日だけを対象に、通信不要な日の出没時刻の計算→
 * 正規の三脚候補計算、を順番に実行する。並列に投げず1件ずつ処理する
 * ことで、通常の検索・他の通信と衝突して端末やAPIを圧迫しないようにする
 * （このダウンロードはユーザーが明示的に許可した「バックグラウンドの
 * 一括処理」であり、体感速度は重視しない、という前回までの合意どおり）。
 */
export async function backfillRollingWindow(params: {
  subjectId: string;
  subjectPoint: GroundPoint;
  cameraSettings: CameraSettings;
  calculationMode: CalculationMode;
  timeZone: string;
  windowDays: number;
  refractionWeather?: RefractionWeatherContext;
  signal?: AbortSignal;
  onProgress?: (progress: RollingWindowProgress) => void;
}): Promise<void> {
  const {
    subjectId,
    subjectPoint,
    cameraSettings,
    calculationMode,
    timeZone,
    windowDays,
    refractionWeather,
    signal,
    onProgress,
  } = params;

  const todayText = zonedDateTimeLocalFromDate(new Date(), timeZone).slice(0, 10);
  const todaySerial = daySerialFromDateText(todayText);
  const dateTexts = Array.from({ length: Math.max(1, Math.round(windowDays)) }, (_, index) =>
    dateTextFromDaySerial(todaySerial + index)
  );

  // まず「どの日がまだ埋まっていないか」を先に全部調べてから作業量を出す
  // ことで、進捗ゲージの分母（totalSteps）を最初から正確に出せる。
  const pendingDates: string[] = [];
  for (const dateText of dateTexts) {
    if (signal?.aborted) return;
    const existing = await getRollingWindowDay(
      subjectId,
      cameraSettings.lensCenterHeightMeters,
      dateText
    );
    const complete = EVENT_DEFINITIONS.every(({ eventKey }) => existing[eventKey] !== null);
    if (!complete) pendingDates.push(dateText);
  }

  const totalSteps = pendingDates.length;
  let completedSteps = 0;
  onProgress?.({ totalSteps, completedSteps, currentDateText: null });
  if (totalSteps === 0) return;

  // 天体観測点は被写体ピンにカメラ高を足した点（通常検索の初期観測点と同じ考え方）。
  const observer = withLensCenterHeight(
    subjectPoint,
    cameraSettings.lensCenterHeightMeters,
    "ローリングウィンドウ観測点"
  );

  for (const dateText of pendingDates) {
    if (signal?.aborted) return;
    onProgress?.({ totalSteps, completedSteps, currentDateText: dateText });

    const dayStart = dateFromZonedDateTimeLocal(`${dateText}T00:00`, timeZone);
    const nextDateText = dateTextFromDaySerial(daySerialFromDateText(dateText) + 1);
    const dayEnd = dateFromZonedDateTimeLocal(`${nextDateText}T00:00`, timeZone);

    for (const { eventKey, bodyId, bodyLabel, direction } of EVENT_DEFINITIONS) {
      if (signal?.aborted) return;
      // 既にこの日・このイベントだけ埋まっている場合は無駄な再計算をしない
      // （pendingDatesは「4件のうち1件でも欠けていれば対象」という粒度の
      // ため、日単位では対象でも個々のイベントは既に埋まっていることがある）。
      const existingDay = await getRollingWindowDay(
        subjectId,
        cameraSettings.lensCenterHeightMeters,
        dateText
      );
      if (existingDay[eventKey] !== null) continue;

      // 日の出没時刻そのものは通信不要（astronomy-engineのみ）で高速に求まる。
      const eventTime = findHorizonCrossing(
        bodyId,
        direction,
        subjectPoint,
        dayStart,
        dayEnd,
        calculationMode,
        refractionWeather
      );
      if (!eventTime) {
        // その日は月の出/月の入りが無い、等の正当なケース。空として保存し、
        // 次回以降に同じ日を無駄に再確認しないようにする。
        await setRollingWindowEntry(subjectId, cameraSettings.lensCenterHeightMeters, dateText, eventKey, {
          eventTimeIso: "",
          candidates: [],
          computedAtIso: new Date().toISOString(),
        });
        continue;
      }

      const point = buildCelestialPoint(
        bodyId,
        bodyLabel,
        eventTime,
        observer,
        calculationMode,
        refractionWeather
      );

      let candidates: TripodCandidate[] = [];
      try {
        // 2026-09-04: 通常のライブ検索（App.tsx）と全く同じ正規経路。
        // ここだけの特別な近道・簡略化は行わない。
        candidates = await calculateTripodCandidates(
          subjectPoint,
          [point],
          cameraSettings,
          eventTime,
          calculationMode,
          undefined,
          signal
        );
      } catch (error) {
        if (signal?.aborted) return;
        console.warn(
          `[rolling-window] ${dateText} ${eventKey} の三脚候補計算に失敗しました`,
          error
        );
        // このイベントだけ諦めて次へ進む（1件の失敗でダウンロード全体を
        // 止めない）。保存もしない＝次回のダウンロードで再挑戦される。
        continue;
      }

      await setRollingWindowEntry(subjectId, cameraSettings.lensCenterHeightMeters, dateText, eventKey, {
        eventTimeIso: eventTime.toISOString(),
        candidates,
        computedAtIso: new Date().toISOString(),
      });
    }

    completedSteps += 1;
    onProgress?.({ totalSteps, completedSteps, currentDateText: dateText });
  }
}
