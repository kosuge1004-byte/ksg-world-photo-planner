import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN, type CameraSettings } from "../types/camera";
import type { PrecisionSettings } from "../types/precision";
import type { CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { SpotSearchDisplayCount, SpotSearchPeriod } from "../types/search";
import {
  celestialTransitDateRange,
  searchCelestialTransitDates,
  type CelestialTransitCriteria,
  type CelestialTransitResult,
  type CelestialTransitSearchMode,
} from "../search/celestialTransitSearch";
import { prepareRefractionWeatherContext } from "../search/refractionWeather";
import {
  JAPANESE_WEEKDAY_LABELS,
  zonedDateTimeLocalFromDate,
  zonedWeekday,
} from "../time/zonedTime";
import {
  DisplayCountSelect,
  TimeRangeSelector,
  WeekdaySelector,
} from "./SearchOptionControls";
import { useSearchTimeRange } from "../search/searchUiPreferences";

const PERIODS: Array<{ value: SpotSearchPeriod; label: string }> = [
  { value: "1-month", label: "30日" },
  { value: "3-months", label: "90日" },
  { value: "6-months", label: "180日" },
  { value: "1-year", label: "365日" },
  { value: "custom", label: "指定期間" },
];

type ResultSortOrder = "date" | "distance";

type Props = {
  open: boolean;
  currentDate: Date;
  timeZone: string;
  tripod: GroundPoint | null;
  subject: GroundPoint | null;
  visibility: CelestialVisibility;
  precisionSettings: PrecisionSettings;
  cameraSettings: CameraSettings;
  previewAspectRatio: number;
  onClose: () => void;
  onSelect: (result: CelestialTransitResult) => void;
};

function resultLabel(result: CelestialTransitResult, timeZone: string): string {
  const local = zonedDateTimeLocalFromDate(result.date, timeZone);
  const [dateText, timeText] = local.split("T");
  const [year, month, day] = dateText.split("-").map(Number);
  const weekday = zonedWeekday(result.date, timeZone);
  return `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}(${JAPANESE_WEEKDAY_LABELS[weekday]}) ${timeText.slice(0, 5)}`;
}

export function CelestialTransitSearchDialog({
  open,
  currentDate,
  timeZone,
  tripod,
  subject,
  visibility,
  precisionSettings,
  cameraSettings,
  previewAspectRatio,
  onClose,
  onSelect,
}: Props) {
  const [searchMode, setSearchMode] = useState<CelestialTransitSearchMode>("direction-crossing");
  const [searchFocalLengthMm, setSearchFocalLengthMm] = useState(cameraSettings.focalLengthMm);
  const [includeBelowSubject, setIncludeBelowSubject] = useState(false);
  const [period, setPeriod] = useState<SpotSearchPeriod>("1-month");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeRange, setTimeRange] = useSearchTimeRange();
  const [displayCount, setDisplayCount] = useState<SpotSearchDisplayCount>(10);
  const [results, setResults] = useState<CelestialTransitResult[]>([]);
  const [resultSortOrder, setResultSortOrder] = useState<ResultSortOrder>("date");
  const [message, setMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || controllerRef.current) return;
    const start = zonedDateTimeLocalFromDate(currentDate, timeZone).slice(0, 10);
    const end = zonedDateTimeLocalFromDate(new Date(currentDate.getTime() + 30 * 86_400_000), timeZone).slice(0, 10);
    setSearchMode("direction-crossing");
    setSearchFocalLengthMm(cameraSettings.focalLengthMm);
    setIncludeBelowSubject(false);
    setCustomStartDate(start);
    setCustomEndDate(end);
    setResults([]);
    setResultSortOrder("date");
    setMessage("");
    setProgressPercent(0);
  }, [cameraSettings.focalLengthMm, currentDate, open, timeZone]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function close() {
    // 検索中に画面を閉じても処理は継続する。
    // これによりスポット検索を並行して開始できる。
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
    setProgressPercent(0);
    setResults([]);
    setMessage("天体通過日時を検索中…");
    try {
      const criteria: CelestialTransitCriteria = {
        mode: searchMode,
        period,
        customStartDate,
        customEndDate,
        weekdays,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
        displayCount,
        includeBelowSubject,
      };
      const range = celestialTransitDateRange({ currentDate, timeZone, criteria });
      const refractionWeather = await prepareRefractionWeatherContext({
        mode: precisionSettings.refractionCorrectionMode,
        point: tripod,
        searchStart: range.start,
        searchEnd: range.end,
        now: currentDate,
        signal: controller.signal,
      });
      const searchCameraSettings: CameraSettings = searchMode === "in-frame"
        ? { ...cameraSettings, focalLengthMm: searchFocalLengthMm }
        : cameraSettings;
      const nextResults = await searchCelestialTransitDates({
        currentDate,
        timeZone,
        tripod,
        subject,
        visibility,
        calculationMode: refractionWeather.effectiveMode === "none" ? "standard" : "pro",
        cameraSettings: searchCameraSettings,
        previewAspectRatio,
        criteria,
        refractionWeather,
      }, controller.signal, setProgressPercent);
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

  const displayedResults = useMemo(() => {
    const sorted = [...results].sort((a, b) => {
      if (resultSortOrder === "distance") {
        const distanceDifference = a.angularDistanceDegrees - b.angularDistanceDegrees;
        if (Math.abs(distanceDifference) > 1e-9) return distanceDifference;
      }
      return a.date.getTime() - b.date.getTime();
    });
    return sorted.slice(0, displayCount);
  }, [displayCount, resultSortOrder, results]);

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
            <legend>被写体より下側の通過</legend>
            <div className="spot-choice-grid">
              <label className={!includeBelowSubject ? "selected" : ""}>
                <input
                  type="radio"
                  name="transit-below-subject-count"
                  checked={!includeBelowSubject}
                  onChange={() => setIncludeBelowSubject(false)}
                />
                <span>除外する（初期値）</span>
              </label>
              <label className={includeBelowSubject ? "selected" : ""}>
                <input
                  type="radio"
                  name="transit-below-subject-count"
                  checked={includeBelowSubject}
                  onChange={() => setIncludeBelowSubject(true)}
                />
                <span>含める</span>
              </label>
            </div>
          </fieldset>

          {searchMode === "in-frame" && (
            <label className="spot-search-field focal celestial-transit-focal">
              <span>検索に使用する焦点距離</span>
              <div>
                <input
                  type="range"
                  min={FOCAL_LENGTH_MIN}
                  max={FOCAL_LENGTH_MAX}
                  step={1}
                  value={searchFocalLengthMm}
                  onChange={(event) => setSearchFocalLengthMm(Number(event.target.value))}
                />
                <input
                  type="number"
                  inputMode="numeric"
                  min={FOCAL_LENGTH_MIN}
                  max={FOCAL_LENGTH_MAX}
                  step={1}
                  value={searchFocalLengthMm}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    setSearchFocalLengthMm(Math.min(FOCAL_LENGTH_MAX, Math.max(FOCAL_LENGTH_MIN, Math.round(value))));
                  }}
                  aria-label="検索焦点距離"
                />
                <small>mm</small>
              </div>
              <small>現在の焦点距離を初期値として使用します。ここで変更してもメイン画面の焦点距離は変わりません。</small>
            </label>
          )}

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
          {isSearching && (
            <div className="celestial-transit-progress" role="progressbar" aria-label="検索進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
              <div className="celestial-transit-progress-track" aria-hidden="true">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <strong>{progressPercent}%</strong>
            </div>
          )}
          {!isSearching && message && <p className="celestial-transit-message" role="status">{message}</p>}
        </form>

        {results.length > 0 && (
          <div className="celestial-transit-results" aria-label="検索結果">
            <div className="celestial-transit-result-sort">
              <span>並べ替え</span>
              <select
                value={resultSortOrder}
                onChange={(event) => setResultSortOrder(event.target.value as ResultSortOrder)}
                aria-label="検索結果の並べ替え"
              >
                <option value="date">日付順</option>
                <option value="distance">画角内の距離が近い順</option>
              </select>
            </div>
            {displayedResults.map((result) => (
              <button key={result.id} type="button" onClick={() => {
                onSelect(result);
                close();
              }}>
                <span>{resultLabel(result, timeZone)}</span>
                <small>被写体との角距離 {result.angularDistanceDegrees.toFixed(2)}°</small>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
