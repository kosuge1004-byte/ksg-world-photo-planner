import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { SpotSearchDisplayCount, SpotSearchPeriod } from "../types/search";
import {
  searchCelestialTransitDates,
  type CelestialTransitResult,
  type CelestialTransitSearchMode,
} from "../search/celestialTransitSearch";
import { zonedDateTimeLocalFromDate } from "../time/zonedTime";
import {
  DisplayCountSelect,
  TimeRangeSelector,
  WeekdaySelector,
  useSearchTimeRange,
} from "./SearchOptionControls";

const PERIODS: Array<{ value: SpotSearchPeriod; label: string }> = [
  { value: "1-month", label: "30日" },
  { value: "3-months", label: "90日" },
  { value: "6-months", label: "180日" },
  { value: "1-year", label: "365日" },
  { value: "custom", label: "指定期間" },
];

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

type Props = {
  open: boolean;
  currentDate: Date;
  timeZone: string;
  tripod: GroundPoint | null;
  subject: GroundPoint | null;
  visibility: CelestialVisibility;
  calculationMode: CalculationMode;
  cameraSettings: CameraSettings;
  previewAspectRatio: number;
  onClose: () => void;
  onSelect: (result: CelestialTransitResult) => void;
};

function resultLabel(result: CelestialTransitResult, timeZone: string): string {
  const local = zonedDateTimeLocalFromDate(result.date, timeZone);
  const [dateText, timeText] = local.split("T");
  const [year, month, day] = dateText.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}(${WEEKDAY_LABELS[weekday]}) ${timeText.slice(0, 5)}`;
}

export function CelestialTransitSearchDialog({
  open,
  currentDate,
  timeZone,
  tripod,
  subject,
  visibility,
  calculationMode,
  cameraSettings,
  previewAspectRatio,
  onClose,
  onSelect,
}: Props) {
  const [searchMode, setSearchMode] = useState<CelestialTransitSearchMode>("direction-crossing");
  const [period, setPeriod] = useState<SpotSearchPeriod>("1-month");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeRange, setTimeRange] = useSearchTimeRange();
  const [displayCount, setDisplayCount] = useState<SpotSearchDisplayCount>(10);
  const [results, setResults] = useState<CelestialTransitResult[]>([]);
  const [message, setMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const start = zonedDateTimeLocalFromDate(currentDate, timeZone).slice(0, 10);
    const end = zonedDateTimeLocalFromDate(new Date(currentDate.getTime() + 30 * 86_400_000), timeZone).slice(0, 10);
    setSearchMode("direction-crossing");
    setCustomStartDate(start);
    setCustomEndDate(end);
    setResults([]);
    setMessage("");
  }, [currentDate, open, timeZone]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function close() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsSearching(false);
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tripod || !subject) {
      setMessage("被写体ピンと三脚ピンを設定してください");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSearching(true);
    setResults([]);
    setMessage("天体通過日時を検索中…");
    try {
      const nextResults = await searchCelestialTransitDates({
        currentDate,
        timeZone,
        tripod,
        subject,
        visibility,
        calculationMode,
        cameraSettings,
        previewAspectRatio,
        criteria: {
          mode: searchMode,
          period,
          customStartDate,
          customEndDate,
          weekdays,
          startTime: timeRange.startTime,
          endTime: timeRange.endTime,
          displayCount,
        },
      }, controller.signal, setMessage);
      if (controller.signal.aborted) return;
      setResults(nextResults);
      setMessage(nextResults.length > 0
        ? `${nextResults.length}件の日時が見つかりました`
        : "指定条件に一致する日時は見つかりませんでした");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage(error instanceof Error ? error.message : "検索に失敗しました");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsSearching(false);
      }
    }
  }

  if (!open) return null;

  return (
    <div className="celestial-transit-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section className="celestial-transit-dialog" role="dialog" aria-modal="true" aria-label="天体通過日時検索">
        <header>
          <h2>天体通過日時検索</h2>
          <button type="button" onClick={close} aria-label="閉じる">×</button>
        </header>
        <form onSubmit={submit}>
          <fieldset className="spot-search-group">
            <legend>検索方法</legend>
            <div className="spot-choice-grid">
              <label className={searchMode === "direction-crossing" ? "selected" : ""}>
                <input type="radio" name="transit-search-mode" checked={searchMode === "direction-crossing"} onChange={() => setSearchMode("direction-crossing")} />
                <span>被写体方向を横切る時刻</span>
              </label>
              <label className={searchMode === "in-frame" ? "selected" : ""}>
                <input type="radio" name="transit-search-mode" checked={searchMode === "in-frame"} onChange={() => setSearchMode("in-frame")} />
                <span>焦点距離の画角内に入る時間</span>
              </label>
            </div>
          </fieldset>

          <fieldset className="spot-search-group">
            <legend>検索期間</legend>
            <div className="spot-choice-grid periods">
              {PERIODS.map((item) => (
                <label key={item.value} className={period === item.value ? "selected" : ""}>
                  <input
                    type="radio"
                    name="transit-search-period"
                    checked={period === item.value}
                    onChange={() => setPeriod(item.value)}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
            {period === "custom" && (
              <div className="spot-custom-period">
                <label><span>開始日</span><input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} /></label>
                <label><span>終了日</span><input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} /></label>
              </div>
            )}
          </fieldset>

          <WeekdaySelector weekdays={weekdays} onChange={setWeekdays} />
          <TimeRangeSelector {...timeRange} onChange={setTimeRange} />
          <DisplayCountSelect value={displayCount} onChange={setDisplayCount} />

          <button type="submit" className="celestial-transit-submit" disabled={isSearching || !tripod || !subject}>
            {isSearching ? "検索中…" : "検索"}
          </button>
          {message && <p className="celestial-transit-message" role="status">{message}</p>}
        </form>

        {results.length > 0 && (
          <div className="celestial-transit-results" aria-label="検索結果">
            {results.map((result) => (
              <button key={result.id} type="button" onClick={() => {
                onSelect(result);
                close();
              }}>
                {resultLabel(result, timeZone)}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
