import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  Body,
  DefineStar,
  Illumination,
  SearchMoonPhase,
} from "astronomy-engine";

import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { calculateCelestialHorizontalCoordinates } from "../cesium/celestial";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  formatZonedTime,
  parseDateTimeLocalParts,
  zonedDateParts,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";

type Props = {
  dateTimeLocal: string;
  location: GroundPoint | null;
  timeZone: string;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
  onChangeDateTime: (value: string) => void;
  onOpenTransitSearch: () => void;
  onInteractionChange?: (interacting: boolean) => void;
};

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;
const MIN_DAY_SERIAL = Date.UTC(MIN_YEAR, 0, 1) / 86_400_000;
const MAX_DAY_SERIAL = Date.UTC(MAX_YEAR, 11, 31) / 86_400_000;
const HOUR_MS = 3_600_000;
const SAMPLE_MINUTES = 5;
// 撮影計画の時刻精度を落とさず、スクロール操作は1分単位で確定する。
const TIMELINE_SNAP_MS = 60_000;
const TIMELINE_HOUR_WIDTH_PX = 52;
const DAY_MS = 86_400_000;

function updateTimelineTimestamp(
  timestamp: number,
  timeZone: string,
  onChangeDateTime: (value: string) => void
) {
  const snapped = Math.round(timestamp / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS;
  const next = new Date(snapped);
  const parts = zonedDateParts(next, timeZone);
  if (parts.year < MIN_YEAR || parts.year > MAX_YEAR) return;
  onChangeDateTime(zonedDateTimeLocalFromDate(next, timeZone));
}

DefineStar(Body.Star2, 17.761122, -29.00781, 26000);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function bodyAltitude(
  id: CelestialBodyId,
  date: Date,
  location: GroundPoint,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): number {
  // 日の出没・月の出没・天の川の可視窓は、天体プレビュー・検索・最終判定と
  // 同じcalculateCelestialHorizontalCoordinates()（気象欠測時の標準大気差
  // フォールバックを含む）だけを経由する。ここに独自の屈折ロジックは持たない。
  return calculateCelestialHorizontalCoordinates(
    id,
    date,
    location,
    calculationMode,
    refractionWeather
  ).altitudeDegrees;
}

function findHorizonCrossing(
  id: CelestialBodyId,
  direction: 1 | -1,
  location: GroundPoint,
  start: Date,
  end: Date,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): Date | null {
  const step = 2 * 60_000;
  let previousTime = start.getTime();
  let previousAltitude = bodyAltitude(
    id,
    start,
    location,
    calculationMode,
    refractionWeather
  );

  for (
    let currentTime = Math.min(previousTime + step, end.getTime());
    currentTime <= end.getTime();
    currentTime = Math.min(currentTime + step, end.getTime())
  ) {
    const currentAltitude = bodyAltitude(
      id,
      new Date(currentTime),
      location,
      calculationMode,
      refractionWeather
    );
    const crossed =
      direction === 1
        ? previousAltitude < 0 && currentAltitude >= 0
        : previousAltitude >= 0 && currentAltitude < 0;
    if (crossed) {
      let low = previousTime;
      let high = currentTime;
      // 表示は分単位だが、候補計算との一貫性を保つため秒未満まで絞り込む。
      for (let index = 0; index < 18; index += 1) {
        const middle = (low + high) / 2;
        const altitude = bodyAltitude(
          id,
          new Date(middle),
          location,
          calculationMode,
          refractionWeather
        );
        if (direction === 1 ? altitude >= 0 : altitude < 0) high = middle;
        else low = middle;
      }
      return new Date(high);
    }
    if (currentTime === end.getTime()) break;
    previousTime = currentTime;
    previousAltitude = currentAltitude;
  }
  return null;
}

function formatWindowTime(
  date: Date,
  selectedDaySerial: number,
  timeZone: string
): string {
  const local = zonedDateTimeLocalFromDate(date, timeZone);
  const offset = daySerialFromDateText(local.slice(0, 10)) - selectedDaySerial;
  const prefix = offset === 1 ? "翌" : offset > 1 ? `${offset}日後` : "";
  return `${prefix}${formatZonedTime(date, timeZone)}`;
}

function formatWindow(
  start: Date | null,
  end: Date | null,
  selectedDaySerial: number,
  timeZone: string
): string {
  if (!start || !end) return "該当なし";
  return `${formatWindowTime(start, selectedDaySerial, timeZone)}～\n${formatWindowTime(end, selectedDaySerial, timeZone)}`;
}

function calculateMoonAgeDays(date: Date): number | null {
  try {
    // 月齢は位相角の単純換算ではなく、直前の朔からの実経過時間で求める。
    const searchStart = new Date(date.getTime() - 35 * DAY_MS);
    let latestNewMoon = SearchMoonPhase(0, searchStart, 40);
    if (!latestNewMoon || latestNewMoon.date.getTime() > date.getTime()) {
      return null;
    }
    for (let index = 0; index < 2; index += 1) {
      const nextNewMoon = SearchMoonPhase(
        0,
        latestNewMoon.AddDays(1),
        35
      );
      if (!nextNewMoon || nextNewMoon.date.getTime() > date.getTime()) break;
      latestNewMoon = nextNewMoon;
    }
    return (date.getTime() - latestNewMoon.date.getTime()) / DAY_MS;
  } catch {
    return null;
  }
}

function milkyWayShootingWindow(
  location: GroundPoint,
  scanStart: Date,
  scanEnd: Date,
  selectedDaySerial: number,
  timeZone: string,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): string {
  let currentStart: Date | null = null;
  let bestStart: Date | null = null;
  let bestEnd: Date | null = null;

  for (
    let time = scanStart.getTime();
    time <= scanEnd.getTime();
    time += SAMPLE_MINUTES * 60_000
  ) {
    const date = new Date(time);
    const sunAltitude = bodyAltitude(
      "sun",
      date,
      location,
      calculationMode,
      refractionWeather
    );
    const moonAltitude = bodyAltitude(
      "moon",
      date,
      location,
      calculationMode,
      refractionWeather
    );
    const milkyWayAltitude = bodyAltitude(
      "milkyWay",
      date,
      location,
      calculationMode,
      refractionWeather
    );
    const moonFraction = Illumination(Body.Moon, date).phase_fraction;
    const moonTooBright = moonAltitude > 0 && moonFraction > 0.35;
    const shootable =
      sunAltitude <= -12 &&
      !moonTooBright &&
      milkyWayAltitude >= 8;

    if (shootable && !currentStart) {
      currentStart = date;
    }

    if ((!shootable || time === scanEnd.getTime()) && currentStart) {
      const candidateEnd = date;
      const bestDuration =
        bestStart && bestEnd ? bestEnd.getTime() - bestStart.getTime() : -1;
      if (candidateEnd.getTime() - currentStart.getTime() > bestDuration) {
        bestStart = currentStart;
        bestEnd = candidateEnd;
      }
      currentStart = null;
    }
  }

  return formatWindow(bestStart, bestEnd, selectedDaySerial, timeZone);
}

function TimelinePanelComponent({
  dateTimeLocal,
  location,
  timeZone,
  calculationMode,
  refractionWeather,
  onChangeDateTime,
  onOpenTransitSearch,
  onInteractionChange,
}: Props) {
  const selectedParts = parseDateTimeLocalParts(dateTimeLocal);
  const selectedDateText = selectedParts
    ? dateTimeLocal.slice(0, 10)
    : zonedDateTimeLocalFromDate(new Date(), timeZone).slice(0, 10);
  const selectedTimeText = selectedParts
    ? dateTimeLocal.slice(11, 16)
    : zonedDateTimeLocalFromDate(new Date(), timeZone).slice(11, 16);
  const selectedDate = dateFromZonedDateTimeLocal(
    `${selectedDateText}T${selectedTimeText}`,
    timeZone
  );
  const selectedTime = selectedDate.getTime();
  const timelineRulerRef = useRef<HTMLDivElement>(null);
  const timelineTimestampRef = useRef(selectedTime);
  const timelineFrameRef = useRef<number | null>(null);
  const pendingTimestampRef = useRef<number | null>(null);
  const wheelIdleTimerRef = useRef<number | null>(null);
  const timelineDragRef = useRef<{
    pointerId: number;
    startX: number;
    startTime: number;
  } | null>(null);
  const selectedDaySerial = Math.min(
    MAX_DAY_SERIAL,
    Math.max(MIN_DAY_SERIAL, daySerialFromDateText(selectedDateText))
  );

  const eventTimes = useMemo(() => {
    if (!location) {
      return {
        sunrise: null,
        sunset: null,
        moonrise: null,
        moonset: null,
        milkyWay: "位置未設定",
      };
    }
    const resolvedLocation: GroundPoint = location;

    const dayText = dateTextFromDaySerial(selectedDaySerial);
    const nextDayText = dateTextFromDaySerial(selectedDaySerial + 1);
    const followingDayText = dateTextFromDaySerial(selectedDaySerial + 2);
    const start = dateFromZonedDateTimeLocal(
      `${dayText}T00:00`,
      timeZone
    );
    const end = dateFromZonedDateTimeLocal(`${nextDayText}T00:00`, timeZone);

    function find(id: CelestialBodyId, direction: 1 | -1): Date | null {
      return findHorizonCrossing(
        id,
        direction,
        resolvedLocation,
        start,
        end,
        calculationMode,
        refractionWeather
      );
    }

    return {
      sunrise: find("sun", 1),
      sunset: find("sun", -1),
      moonrise: find("moon", 1),
      moonset: find("moon", -1),
      milkyWay: milkyWayShootingWindow(
        resolvedLocation,
        dateFromZonedDateTimeLocal(`${dayText}T12:00`, timeZone),
        dateFromZonedDateTimeLocal(`${followingDayText}T12:00`, timeZone),
        selectedDaySerial,
        timeZone,
        calculationMode,
        refractionWeather
      ),
    };
  }, [calculationMode, location, refractionWeather, selectedDaySerial, timeZone]);
  const moonAgeDays = useMemo(() => {
    // 月齢は同じ日内で時刻スクロールのたびに朔検索を繰り返さない。
    const reference = eventTimes.moonrise ?? dateFromZonedDateTimeLocal(
      `${selectedDateText}T12:00`,
      timeZone
    );
    return calculateMoonAgeDays(reference);
  }, [eventTimes.moonrise, selectedDateText, timeZone]);

  useEffect(() => {
    // 高分解能トラックパッドの連続wheel間でも差分を失わないよう、表示時刻とは別に累積値を保持する。
    if (timelineFrameRef.current === null) {
      timelineTimestampRef.current = selectedTime;
    }
  }, [selectedTime]);

  useEffect(() => () => {
    if (timelineFrameRef.current !== null) {
      cancelAnimationFrame(timelineFrameRef.current);
    }
    if (wheelIdleTimerRef.current !== null) {
      window.clearTimeout(wheelIdleTimerRef.current);
    }
  }, []);

  function changeDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    onChangeDateTime(`${value}T${selectedTimeText}`);
  }

  const timelineTicks = useMemo(() => {
    const baseTime = Math.floor(selectedTime / (10 * 60_000)) * 10 * 60_000;
    return Array.from({ length: 73 }, (_, index) => {
      const time = baseTime + (index - 36) * 10 * 60_000;
      const parts = zonedDateParts(new Date(time), timeZone);
      return {
        time,
        label: parts.minute === 0 ? `${pad2(parts.hour)}:00` : "",
        major: parts.minute === 0,
        left: `calc(50% + ${(time - selectedTime) / HOUR_MS * TIMELINE_HOUR_WIDTH_PX}px)`,
      };
    });
  }, [selectedTime, timeZone]);

  const updateTimelineTime = useCallback((timestamp: number) => {
    timelineTimestampRef.current = timestamp;
    pendingTimestampRef.current = timestamp;
    if (timelineFrameRef.current !== null) return;
    // 入力イベントを1描画につき1回へまとめ、天体位置は指の動きへ追従したまま過剰再計算を防ぐ。
    timelineFrameRef.current = requestAnimationFrame(() => {
      timelineFrameRef.current = null;
      const pending = pendingTimestampRef.current;
      pendingTimestampRef.current = null;
      if (pending !== null) {
        updateTimelineTimestamp(pending, timeZone, onChangeDateTime);
      }
    });
  }, [onChangeDateTime, timeZone]);

  useEffect(() => {
    const ruler = timelineRulerRef.current;
    if (!ruler) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      onInteractionChange?.(true);
      if (wheelIdleTimerRef.current !== null) {
        window.clearTimeout(wheelIdleTimerRef.current);
      }
      wheelIdleTimerRef.current = window.setTimeout(() => {
        wheelIdleTimerRef.current = null;
        onInteractionChange?.(false);
      }, 140);
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const pixelDelta = delta * (
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, ruler.clientWidth)
            : 1
      );
      // 目盛の実寸と同じ比率で移動させ、ホイール1イベント固定の飛びをなくす。
      const nextTimestamp =
        timelineTimestampRef.current +
        pixelDelta / TIMELINE_HOUR_WIDTH_PX * HOUR_MS;
      updateTimelineTime(nextTimestamp);
    };
    // 時間軸のホイールを確実に捕捉するためnon-passiveで登録する。
    ruler.addEventListener("wheel", wheel, { passive: false });
    return () => ruler.removeEventListener("wheel", wheel);
  }, [onInteractionChange, updateTimelineTime]);

  function startTimelineDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    onInteractionChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    timelineDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startTime: selectedTime,
    };
  }

  function moveTimelineDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = timelineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const timeDelta =
      ((drag.startX - event.clientX) / TIMELINE_HOUR_WIDTH_PX) * HOUR_MS;
    updateTimelineTime(drag.startTime + timeDelta);
  }

  function stopTimelineDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelineDragRef.current?.pointerId !== event.pointerId) return;
    timelineDragRef.current = null;
    onInteractionChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function useTimelineKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    updateTimelineTime(
      selectedTime + direction * (event.shiftKey ? HOUR_MS : TIMELINE_SNAP_MS)
    );
  }

  return (
    <section className="timeline-section" aria-label="撮影日時">
      <div className="timeline-main-row">
        <div className="timeline-title">
          時間
        </div>

        <div className="timeline-ruler-shell">
          <div
            ref={timelineRulerRef}
            className="timeline-ruler timeline-scroll-ruler"
            role="slider"
            tabIndex={0}
            aria-label="撮影時刻。左右にドラッグして変更"
            aria-valuetext={selectedTimeText}
            onPointerDown={startTimelineDrag}
            onPointerMove={moveTimelineDrag}
            onPointerUp={stopTimelineDrag}
            onPointerCancel={stopTimelineDrag}
            onKeyDown={useTimelineKeyboard}
          >
            <output
              className="timeline-current-time"
            >
              {selectedTimeText}
            </output>
            <div className="timeline-scroll-track" aria-hidden="true">
              {timelineTicks.map((tick) => (
                <span
                  key={tick.time}
                  className={tick.major ? "timeline-scroll-tick major" : "timeline-scroll-tick"}
                  style={{ left: tick.left }}
                >
                  {tick.label && <b>{tick.label}</b>}
                </span>
              ))}
            </div>
            <span className="timeline-selection-line" aria-hidden="true" />
          </div>
          <button
            type="button"
            className="timeline-minute-step timeline-minute-step-back"
            aria-label="時刻を1分戻す"
            title="1分戻す"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => updateTimelineTime(selectedTime - TIMELINE_SNAP_MS)}
          >
            −1
          </button>
          <button
            type="button"
            className="timeline-minute-step timeline-minute-step-forward"
            aria-label="時刻を1分進める"
            title="1分進める"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => updateTimelineTime(selectedTime + TIMELINE_SNAP_MS)}
          >
            +1
          </button>
        </div>

        <div className="timeline-date-actions">
          <label className="timeline-date-control" aria-label="撮影日">
            <input
              type="date"
              min={`${MIN_YEAR}-01-01`}
              max={`${MAX_YEAR}-12-31`}
              value={selectedDateText}
              onChange={(event) => changeDate(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="timeline-transit-search-button"
            onClick={onOpenTransitSearch}
            aria-label="天体通過日時検索"
            title="天体通過日時検索"
          >
            <span aria-hidden="true">🔍</span>
          </button>
        </div>
      </div>

      <div className="celestial-event-row" aria-label="日の出・日の入り時刻">
        <div className="event-card sunrise"><span>☀</span><b>日の出</b><strong>{formatZonedTime(eventTimes.sunrise, timeZone)}</strong></div>
        <div className="event-card sunset"><span>▣</span><b>日没</b><strong>{formatZonedTime(eventTimes.sunset, timeZone)}</strong></div>
        <div className="event-card moonrise"><span>☾</span><b>月出<i>月齢{moonAgeDays === null ? "--" : moonAgeDays.toFixed(1)}</i></b><strong>{formatZonedTime(eventTimes.moonrise, timeZone)}</strong></div>
        <div className="event-card moonset"><span>☾</span><b>月没</b><strong>{formatZonedTime(eventTimes.moonset, timeZone)}</strong></div>
        <div className="event-card milkyway" title="太陽高度−12°以下・月明かりが弱い・天の川中心高度8°以上"><span>✦</span><b>天の川</b><strong>{eventTimes.milkyWay}</strong></div>
      </div>

      <input
        className="timeline-day-slider"
        aria-label="撮影日を変更"
        type="range"
        min={MIN_DAY_SERIAL}
        max={MAX_DAY_SERIAL}
        step="1"
        value={selectedDaySerial}
        onChange={(event) =>
          onChangeDateTime(
            `${dateTextFromDaySerial(Number(event.target.value))}T${selectedTimeText}`
          )
        }
      />
    </section>
  );
}

export const TimelinePanel = memo(TimelinePanelComponent);
