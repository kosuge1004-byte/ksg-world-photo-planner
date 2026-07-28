import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";

import { FOCAL_LENGTH_MAX, FOCAL_LENGTH_MIN } from "../types/camera";
import type {
  SearchCelestialId,
  SpotCandidate3dStatus,
  SpotPresetResult,
  SpotSearchCriteria,
  SpotSearchDisplayCount,
  SpotSearchInterval,
  SpotSearchPeriod,
  SunSearchTiming,
} from "../types/search";
import {
  formatZonedDateTimeWithWeekday,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";
import type { SiteConstraintFlags } from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import type { PrecisionSettings } from "../types/precision";
import type { SubjectRecord } from "../subjectStorage";
import {
  DisplayCountSelect,
  TimeRangeSelector,
  WeekdaySelector,
} from "./SearchOptionControls";
import { useSearchTimeRange } from "../search/searchUiPreferences";
import { calculateKarneySurfaceDistanceMeters } from "../geodesy/karneyGeodesic";

type Props = {
  open: boolean;
  hasCurrentSubject: boolean;
  initialFocalLengthMm: number;
  initialDate: Date;
  initialTimeZone: string;
  precisionSettings: PrecisionSettings;
  onBack: () => void;
  onSearch: (
    criteria: SpotSearchCriteria,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ) => Promise<SpotPresetResult[]>;
  onResumeSearch: (
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ) => Promise<SpotPresetResult[] | null>;
  onLocateSubject: (
    query: string,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ) => Promise<void>;
  currentSubject: GroundPoint | null;
  history: SubjectRecord[];
  favorites: SubjectRecord[];
  currentSubjectIsFavorite: boolean;
  onSelectStoredSubject: (record: SubjectRecord) => void;
  onToggleCurrentFavorite: () => void;
  onToggleFavorite: (record: SubjectRecord) => void;
  onSelect: (result: SpotPresetResult) => void;
};

const PERIODS: Array<{ value: SpotSearchPeriod; label: string }> = [
  { value: "1-month", label: "直近1か月" },
  { value: "3-months", label: "直近3か月" },
  { value: "6-months", label: "直近6か月" },
  { value: "1-year", label: "直近1年" },
  { value: "custom", label: "期間指定" },
];

const INTERVALS: Array<{ value: SpotSearchInterval; label: string }> = [
  { value: "1-minute", label: "1分" },
  { value: "5-minutes", label: "5分" },
  { value: "10-minutes", label: "10分" },
  { value: "15-minutes", label: "15分" },
  { value: "30-minutes", label: "30分" },
  { value: "1-hour", label: "1時間" },
  { value: "1-day", label: "1日" },
  { value: "1-week", label: "1週間" },
  { value: "1-month", label: "1か月" },
];

const CELESTIALS: Array<{ value: SearchCelestialId; label: string; symbol: string }> = [
  { value: "sun", label: "太陽", symbol: "☀" },
  { value: "moon", label: "月", symbol: "☾" },
  { value: "milkyWay", label: "天の川", symbol: "✦" },
];

const SUN_SEARCH_TIMINGS: Array<{ value: SunSearchTiming; label: string }> = [
  { value: "all", label: "すべての時間" },
  { value: "sunrise", label: "日の出付近" },
  { value: "sunset", label: "日の入り付近" },
  { value: "sunrise-sunset", label: "日の出・日の入り" },
];

const MOON_AGE_MAX_DAYS = 29.53;
const TRIPOD_DISTANCE_MIN_METERS = 0;
const TRIPOD_DISTANCE_MAX_METERS = 10_000;
const TRIPOD_DISTANCE_DEFAULT_MIN_METERS = 500;
const TRIPOD_DISTANCE_DEFAULT_MAX_METERS = 3_000;
const TRIPOD_DISTANCE_STORAGE_KEY = "ksg-spot-search-tripod-distance-v1";
const RETAINED_RESULTS_STORAGE_KEY = "ksg-retained-spot-search-results-v1";
const RESULT_SORT_STORAGE_KEY = "ksg-spot-search-result-sort-v1";
type SpotResultSort = "date" | "distance";

type StoredTripodDistance = { minMeters: number; maxMeters: number };
type StoredSpotPresetResult = Omit<SpotPresetResult, "date"> & { date: string };

function isCandidate3dStatus(value: unknown): value is SpotCandidate3dStatus {
  return value === "visible" ||
    value === "possibly-obstructed" ||
    value === "unverified" ||
    value === "disabled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadRetainedResults(): SpotPresetResult[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(RETAINED_RESULTS_STORAGE_KEY) ?? "[]"
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.date !== "string" ||
        !Number.isFinite(Date.parse(value.date)) ||
        typeof value.placeLabel !== "string" ||
        typeof value.timeZone !== "string" ||
        !isRecord(value.subject) ||
        !isRecord(value.tripod) ||
        !Array.isArray(value.nearbyLandmarks) ||
        !Array.isArray(value.nearbyBuildings) ||
        !Array.isArray(value.nearbyStructures)
      ) return [];
      const stored = value as StoredSpotPresetResult;
      return [{
        ...stored,
        date: new Date(stored.date),
        // 旧保存結果も削除せず、状態不明の候補として復元する。
        candidate3dStatus: isCandidate3dStatus(stored.candidate3dStatus)
          ? stored.candidate3dStatus
          : "unverified",
      }];
    });
  } catch {
    return [];
  }
}

function saveRetainedResults(results: SpotPresetResult[]): void {
  if (typeof window === "undefined") return;
  try {
    const stored: StoredSpotPresetResult[] = results.slice(0, 100).map((result) => ({
      ...result,
      date: result.date.toISOString(),
    }));
    window.localStorage.setItem(RETAINED_RESULTS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // 容量制限やプライベートモードでも検索結果表示そのものは継続する。
  }
}

function candidate3dStatusLabel(
  status: SpotCandidate3dStatus,
  obstructedFractionPercent?: number
): string {
  if (status === "visible") {
    return typeof obstructedFractionPercent === "number"
      ? `被写体までの3D：見通し確認済み（縁の遮蔽 ${Math.round(obstructedFractionPercent)}%）`
      : "被写体までの3D：見通し確認済み";
  }
  if (status === "possibly-obstructed") {
    return typeof obstructedFractionPercent === "number"
      ? `被写体までの3D：遮蔽物あり（縁の遮蔽 ${Math.round(obstructedFractionPercent)}%）`
      : "被写体までの3D：遮蔽物あり";
  }
  if (status === "disabled") return "被写体までの3D：確認OFF";
  return "被写体までの3D：未確認";
}

function clampTripodDistance(value: number): number {
  return Math.min(
    TRIPOD_DISTANCE_MAX_METERS,
    Math.max(TRIPOD_DISTANCE_MIN_METERS, Number.isFinite(value) ? value : 0)
  );
}

function loadTripodDistance(): StoredTripodDistance {
  if (typeof window === "undefined") {
    return {
      minMeters: TRIPOD_DISTANCE_DEFAULT_MIN_METERS,
      maxMeters: TRIPOD_DISTANCE_DEFAULT_MAX_METERS,
    };
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(TRIPOD_DISTANCE_STORAGE_KEY) ?? "null"
    ) as Partial<StoredTripodDistance> | null;
    const minMeters = clampTripodDistance(Number(parsed?.minMeters));
    const maxMeters = clampTripodDistance(Number(parsed?.maxMeters));
    if (Number.isFinite(Number(parsed?.minMeters)) &&
        Number.isFinite(Number(parsed?.maxMeters)) &&
        minMeters <= maxMeters) {
      return { minMeters, maxMeters };
    }
  } catch {
    // 保存値が壊れている場合は初期値へ戻す。
  }
  return {
    minMeters: TRIPOD_DISTANCE_DEFAULT_MIN_METERS,
    maxMeters: TRIPOD_DISTANCE_DEFAULT_MAX_METERS,
  };
}


function loadResultSort(): SpotResultSort {
  if (typeof window === "undefined") return "date";
  return window.localStorage.getItem(RESULT_SORT_STORAGE_KEY) === "distance"
    ? "distance"
    : "date";
}

function resultDistanceMeters(result: SpotPresetResult): number {
  return calculateKarneySurfaceDistanceMeters(result.tripod, result.subject);
}

function formatResultDistance(distanceMeters: number): string {
  return distanceMeters < 1_000
    ? `${Math.round(distanceMeters)}m`
    : `${(distanceMeters / 1_000).toFixed(distanceMeters < 10_000 ? 2 : 1)}km`;
}

function resultDateTime(result: SpotPresetResult): string {
  return formatZonedDateTimeWithWeekday(result.date, result.timeZone);
}

export function SpotSearchScreen({
  open,
  hasCurrentSubject,
  initialFocalLengthMm,
  initialDate,
  initialTimeZone,
  precisionSettings,
  onBack,
  onSearch,
  onResumeSearch,
  onLocateSubject,
  currentSubject,
  history,
  favorites,
  currentSubjectIsFavorite,
  onSelectStoredSubject,
  onToggleCurrentFavorite,
  onToggleFavorite,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [subjectListOpen, setSubjectListOpen] = useState<"history" | "favorites" | null>(null);
  const [searchDateTime, setSearchDateTime] = useState(false);
  const [useCurrentSubjectPin, setUseCurrentSubjectPin] = useState(false);
  const [celestialId, setCelestialId] = useState<SearchCelestialId>("moon");
  const [sunSearchTiming, setSunSearchTiming] = useState<SunSearchTiming>("all");
  const [moonAgeMinDays, setMoonAgeMinDays] = useState(1);
  const [moonAgeMaxDays, setMoonAgeMaxDays] = useState(28);
  const [focalLengthMm, setFocalLengthMm] = useState(initialFocalLengthMm);
  const [initialTripodDistance] = useState(loadTripodDistance);
  const [tripodDistanceMinMeters, setTripodDistanceMinMeters] = useState(
    initialTripodDistance.minMeters
  );
  const [tripodDistanceMaxMeters, setTripodDistanceMaxMeters] = useState(
    initialTripodDistance.maxMeters
  );
  const [period, setPeriod] = useState<SpotSearchPeriod>("1-month");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeRange, setTimeRange] = useSearchTimeRange();
  const [interval, setInterval] = useState<SpotSearchInterval>("30-minutes");
  const [displayCount, setDisplayCount] = useState<SpotSearchDisplayCount>(10);
  const [subjectObstructionCheckEnabled, setSubjectObstructionCheckEnabled] = useState(true);
  const [siteConstraints, setSiteConstraints] = useState<SiteConstraintFlags>({
    walkingOnly: false,
    roadsAndPathsOnly: false,
    excludePrivateAccess: false,
    elevationDifferenceWithin100m: false,
    excludeRoads: false,
  });
  const [results, setResults] = useState<SpotPresetResult[]>(loadRetainedResults);
  const [resultSort, setResultSort] = useState<SpotResultSort>(loadResultSort);
  const [selectedResult, setSelectedResult] = useState<SpotPresetResult | null>(null);
  const [message, setMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const lastProgressMessageRef = useRef("");
  const resumeSearchRef = useRef(onResumeSearch);
  resumeSearchRef.current = onResumeSearch;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      TRIPOD_DISTANCE_STORAGE_KEY,
      JSON.stringify({
        minMeters: tripodDistanceMinMeters,
        maxMeters: tripodDistanceMaxMeters,
      })
    );
  }, [tripodDistanceMaxMeters, tripodDistanceMinMeters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RESULT_SORT_STORAGE_KEY, resultSort);
  }, [resultSort]);

  const sortedResults = useMemo(() => {
    const sorted = [...results];
    sorted.sort((left, right) => {
      if (resultSort === "distance") {
        const distanceDifference = resultDistanceMeters(left) - resultDistanceMeters(right);
        if (Math.abs(distanceDifference) > 0.01) return distanceDifference;
      }
      return left.date.getTime() - right.date.getTime();
    });
    return sorted;
  }, [resultSort, results]);

  useEffect(() => {
    // メイン画面へ構図を適用しても検索結果を失わず、
    // 次の検索が完了して結果が置き換わるまで端末内へ保持する。
    saveRetainedResults(results);
  }, [results]);

  useEffect(() => {
    if (!open) return;
    const startDate = zonedDateTimeLocalFromDate(
      initialDate,
      initialTimeZone
    ).slice(0, 10);
    const end = new Date(initialDate.getTime() + 30 * 86_400_000);
    setFocalLengthMm(initialFocalLengthMm);
    setCustomStartDate(startDate);
    setCustomEndDate(
      zonedDateTimeLocalFromDate(end, initialTimeZone).slice(0, 10)
    );
    setMessage("");
    setProgressPercent(0);
    setIsPaused(false);
    setSelectedResult(null);
    setSubjectListOpen(null);
    if (!hasCurrentSubject) setUseCurrentSubjectPin(false);
  }, [hasCurrentSubject, initialDate, initialFocalLengthMm, initialTimeZone, open]);

  useEffect(() => {
    // バックグラウンド構図検索の再開確認は、
    // 「日時・構図候補も検索」が有効な場合だけ行う。
    // スポット検索のみの画面で再開待機を始めると、
    // 検索ボタンが「検索中」のまま無効になるため。
    if (!open || !searchDateTime || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSearching(true);
    void resumeSearchRef.current(controller.signal, (nextMessage, percent) => {
      setMessage(nextMessage);
      setProgressPercent(percent);
    })
      .then((resumedResults) => {
        if (controller.signal.aborted || resumedResults === null) return;
        setResults(resumedResults);
        setMessage(
          resumedResults.length > 0
            ? `${resumedResults.length}件のバックグラウンド検索結果を取得しました`
            : "バックグラウンド検索に一致する候補はありませんでした"
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "検索の再開に失敗しました");
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setIsSearching(false);
        }
      });
    return () => controller.abort();
  }, [open, searchDateTime]);

  function closeScreen() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsSearching(false);
    setProgressPercent(0);
    setIsPaused(false);
    onBack();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((!searchDateTime || !useCurrentSubjectPin) && !query.trim()) {
      setMessage("スポット名またはGoogleマップ共有URLを入力してください");
      return;
    }
    if (
      searchDateTime &&
      tripodDistanceMinMeters > tripodDistanceMaxMeters
    ) {
      setMessage("三脚距離の最小値は最大値以下にしてください");
      return;
    }
    if (
      searchDateTime &&
      celestialId === "moon" &&
      moonAgeMinDays > moonAgeMaxDays
    ) {
      setMessage("月齢の下限は上限以下にしてください");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSearching(true);
    lastProgressMessageRef.current = "";
    setProgressPercent(0);
    setIsPaused(false);
    setMessage("スポットを検索しています…");
    try {
      if (!searchDateTime) {
        await onLocateSubject(query.trim(), controller.signal, setMessage);
        return;
      }
      const criteria: SpotSearchCriteria = {
        query: query.trim(),
        useCurrentSubjectPin,
        celestialId,
        sunSearchTiming,
        moonAgeMinDays,
        moonAgeMaxDays,
        focalLengthMm,
        tripodDistanceMinMeters,
        tripodDistanceMaxMeters,
        period,
        customStartDate,
        customEndDate,
        weekdays,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
        interval,
        displayCount,
        siteConstraints,
        subjectObstructionCheckEnabled,
        subjectObstructionExclusionMeters: precisionSettings.subjectObstructionExclusionMeters,
        buildingOcclusionDetailSettings: precisionSettings.buildingOcclusionDetailSettings,
      };
      const nextResults = await onSearch(
        criteria,
        controller.signal,
        (nextMessage, percent) => {
          lastProgressMessageRef.current = nextMessage;
          setMessage(nextMessage);
          setProgressPercent(percent);
        }
      );
      if (controller.signal.aborted) return;
      setResults(nextResults);
      setProgressPercent(100);
      const diagnostic = lastProgressMessageRef.current.includes("検索診断")
        ? lastProgressMessageRef.current.slice(
            lastProgressMessageRef.current.indexOf("検索診断")
          )
        : "";
      setMessage(
        `${nextResults.length > 0
          ? `${nextResults.length}件の構図候補が見つかりました`
          : "指定条件で地表上に三脚解を持つ候補は見つかりませんでした"}${diagnostic ? `
${diagnostic}` : ""}`
      );
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

  if (selectedResult) {
    return (
      <section className="spot-search-screen" aria-label="検索結果詳細">
        <header className="spot-search-header">
          <button type="button" onClick={() => setSelectedResult(null)} aria-label="検索結果へ戻る">
            <span aria-hidden="true">‹</span>戻る
          </button>
          <h1>検索結果詳細</h1>
          <span aria-hidden="true" />
        </header>
        <div className="spot-result-detail">
          <article>
            <small>{selectedResult.celestialLabel}</small>
            <h2>{selectedResult.placeLabel}</h2>
            <dl>
              <div><dt>撮影日時</dt><dd>{resultDateTime(selectedResult)}</dd></div>
              <div><dt>焦点距離</dt><dd>{selectedResult.focalLengthMm}mm</dd></div>
              <div><dt>カメラ方位</dt><dd>{selectedResult.cameraAzimuthDegrees.toFixed(2)}°</dd></div>
              <div><dt>カメラ仰角</dt><dd>{selectedResult.cameraAltitudeDegrees.toFixed(2)}°</dd></div>
              <div>
                <dt>3D確認状態</dt>
                <dd>{candidate3dStatusLabel(selectedResult.candidate3dStatus, selectedResult.buildingObstructedFractionPercent)}</dd>
              </div>
              <div><dt>三脚位置</dt><dd>{selectedResult.tripod.latitude.toFixed(6)}, {selectedResult.tripod.longitude.toFixed(6)}</dd></div>
              <div><dt>被写体位置</dt><dd>{selectedResult.subject.latitude.toFixed(6)}, {selectedResult.subject.longitude.toFixed(6)}</dd></div>
            </dl>
          </article>
          <button type="button" className="spot-result-apply" onClick={() => onSelect(selectedResult)}>
            この構図を適用
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="spot-search-screen" aria-label="スポット検索">
      <header className="spot-search-header">
        <button type="button" onClick={closeScreen} aria-label="メイン画面へ戻る">
          <span aria-hidden="true">‹</span>
          戻る
        </button>
        <h1>スポット検索</h1>
        <span aria-hidden="true" />
      </header>

      <form className="spot-search-content" onSubmit={submit}>
        <div className="spot-subject-search-block">
          <label className="spot-search-field">
            <span>スポット名</span>
            <div className="spot-subject-input-row">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="地名 / Googleマップ共有URL"
                autoComplete="off"
                disabled={searchDateTime && useCurrentSubjectPin}
              />
              <button type="button" className={currentSubjectIsFavorite ? "spot-subject-icon active" : "spot-subject-icon"} aria-label="現在の被写体をお気に入り登録" disabled={!currentSubject} onClick={onToggleCurrentFavorite}>★</button>
              <button type="button" className="spot-subject-icon" aria-label="お気に入りを表示" onClick={() => setSubjectListOpen((value) => value === "favorites" ? null : "favorites")}>☆</button>
              <button type="button" className="spot-subject-icon" aria-label="検索履歴を表示" onClick={() => setSubjectListOpen((value) => value === "history" ? null : "history")}>◷</button>
            </div>
          </label>
          {subjectListOpen && (
            <section className="spot-subject-list" aria-label={subjectListOpen === "history" ? "検索履歴" : "お気に入り"}>
              <header>
                <strong>{subjectListOpen === "history" ? "最近の検索" : "お気に入り"}</strong>
                <button type="button" onClick={() => setSubjectListOpen(null)} aria-label="閉じる">×</button>
              </header>
              {(subjectListOpen === "history" ? history : favorites).length === 0 ? (
                <p>{subjectListOpen === "history" ? "検索履歴はありません" : "お気に入りはありません"}</p>
              ) : (subjectListOpen === "history" ? history : favorites).map((record) => (
                <div className="spot-subject-list-item" key={record.id}>
                  <button type="button" onClick={() => onSelectStoredSubject(record)}>
                    <strong>{record.label}</strong>
                    <small>{record.latitude.toFixed(6)}, {record.longitude.toFixed(6)}</small>
                  </button>
                  <button type="button" className="spot-list-favorite" aria-label="お気に入り切替" onClick={() => onToggleFavorite(record)}>
                    {favorites.some((favorite) => favorite.id === record.id) ? "★" : "☆"}
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>

        <label className={searchDateTime
          ? "spot-search-date-toggle selected"
          : "spot-search-date-toggle"}>
          <input
            type="checkbox"
            checked={searchDateTime}
            onChange={(event) => setSearchDateTime(event.target.checked)}
          />
          <span>
            <strong>日時・構図候補も検索</strong>
            <small>チェック時のみ天体条件と三脚候補を計算</small>
          </span>
        </label>

        {searchDateTime && <>

        <label className={useCurrentSubjectPin
          ? "spot-search-date-toggle selected"
          : "spot-search-date-toggle"}>
          <input
            type="checkbox"
            checked={useCurrentSubjectPin}
            disabled={!hasCurrentSubject}
            onChange={(event) => setUseCurrentSubjectPin(event.target.checked)}
          />
          <span>
            <strong>現在の被写体ピンを使用</strong>
            <small>
              {hasCurrentSubject
                ? "入力したスポット名を使わず、現在の被写体位置から検索"
                : "先にメイン画面で被写体ピンを配置してください"}
            </small>
          </span>
        </label>

        <fieldset className="spot-search-group">
          <legend>天体選択</legend>
          <div className="spot-choice-grid celestial">
            {CELESTIALS.map((item) => (
              <label key={item.value} className={celestialId === item.value ? "selected" : ""}>
                <input
                  type="radio"
                  name="search-celestial"
                  value={item.value}
                  checked={celestialId === item.value}
                  onChange={() => setCelestialId(item.value)}
                />
                <b aria-hidden="true">{item.symbol}</b>
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {celestialId === "sun" && (
          <fieldset className="spot-search-group">
            <legend>太陽の時間帯</legend>
            <div className="spot-choice-grid sun-timing">
              {SUN_SEARCH_TIMINGS.map((item) => (
                <label
                  key={item.value}
                  className={sunSearchTiming === item.value ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="sun-search-timing"
                    checked={sunSearchTiming === item.value}
                    onChange={() => setSunSearchTiming(item.value)}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {celestialId === "moon" && (
          <fieldset className="spot-search-group moon-age-range">
            <legend>月齢範囲</legend>
            <div>
              <label>
                <span>下限</span>
                <input
                  type="number"
                  min={0}
                  max={MOON_AGE_MAX_DAYS}
                  step={0.1}
                  value={moonAgeMinDays}
                  onChange={(event) => setMoonAgeMinDays(Math.min(
                    MOON_AGE_MAX_DAYS,
                    Math.max(0, Number(event.target.value))
                  ))}
                />
              </label>
              <span aria-hidden="true">〜</span>
              <label>
                <span>上限</span>
                <input
                  type="number"
                  min={0}
                  max={MOON_AGE_MAX_DAYS}
                  step={0.1}
                  value={moonAgeMaxDays}
                  onChange={(event) => setMoonAgeMaxDays(Math.min(
                    MOON_AGE_MAX_DAYS,
                    Math.max(0, Number(event.target.value))
                  ))}
                />
              </label>
              <small>日</small>
            </div>
            <small>0〜29.53で指定。初期値は月齢1〜28です。</small>
          </fieldset>
        )}

        <label className="spot-search-field focal">
          <span>焦点距離</span>
          <div>
            <input
              type="range"
              min={FOCAL_LENGTH_MIN}
              max={FOCAL_LENGTH_MAX}
              value={focalLengthMm}
              onChange={(event) => setFocalLengthMm(Number(event.target.value))}
            />
            <input
              type="number"
              min={FOCAL_LENGTH_MIN}
              max={FOCAL_LENGTH_MAX}
              value={focalLengthMm}
              onChange={(event) => setFocalLengthMm(
                Math.min(
                  FOCAL_LENGTH_MAX,
                  Math.max(FOCAL_LENGTH_MIN, Number(event.target.value))
                )
              )}
            />
            <small>mm</small>
          </div>
        </label>

        <fieldset className="spot-search-group tripod-distance-range">
          <legend>被写体から三脚までの距離</legend>
          <div className="tripod-distance-slider-row">
            <label>
              <span>最小</span>
              <input
                type="range"
                min={TRIPOD_DISTANCE_MIN_METERS}
                max={TRIPOD_DISTANCE_MAX_METERS}
                step={50}
                value={tripodDistanceMinMeters}
                onChange={(event) => setTripodDistanceMinMeters(
                  Math.min(
                    tripodDistanceMaxMeters,
                    clampTripodDistance(Number(event.target.value))
                  )
                )}
              />
            </label>
            <label>
              <span>最大</span>
              <input
                type="range"
                min={TRIPOD_DISTANCE_MIN_METERS}
                max={TRIPOD_DISTANCE_MAX_METERS}
                step={50}
                value={tripodDistanceMaxMeters}
                onChange={(event) => setTripodDistanceMaxMeters(
                  Math.max(
                    tripodDistanceMinMeters,
                    clampTripodDistance(Number(event.target.value))
                  )
                )}
              />
            </label>
          </div>
          <div className="tripod-distance-number-row">
            <label>
              <span>最小距離</span>
              <input
                type="number"
                min={TRIPOD_DISTANCE_MIN_METERS}
                max={TRIPOD_DISTANCE_MAX_METERS}
                step={50}
                value={tripodDistanceMinMeters}
                onChange={(event) => setTripodDistanceMinMeters(
                  clampTripodDistance(Number(event.target.value))
                )}
              />
              <small>m</small>
            </label>
            <span aria-hidden="true">〜</span>
            <label>
              <span>最大距離</span>
              <input
                type="number"
                min={TRIPOD_DISTANCE_MIN_METERS}
                max={TRIPOD_DISTANCE_MAX_METERS}
                step={50}
                value={tripodDistanceMaxMeters}
                onChange={(event) => setTripodDistanceMaxMeters(
                  clampTripodDistance(Number(event.target.value))
                )}
              />
              <small>m</small>
            </label>
          </div>
          <small className="tripod-distance-note">
            0〜10,000mで指定。初期値は500〜3,000mです。
          </small>
        </fieldset>

        <fieldset className="spot-search-group">
          <legend>検索期間</legend>
          <div className="spot-choice-grid periods">
            {PERIODS.map((item) => (
              <label key={item.value} className={period === item.value ? "selected" : ""}>
                <input
                  type="radio"
                  name="search-period"
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

        <label className="spot-search-field">
          <span>検索間隔</span>
          <select value={interval} onChange={(event) => setInterval(event.target.value as SpotSearchInterval)}>
            {INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>

        <DisplayCountSelect value={displayCount} onChange={setDisplayCount} />

        <fieldset className="spot-search-group">
          <legend>三脚位置条件</legend>
          <div className="spot-condition-grid">
            <label className={siteConstraints.walkingOnly ? "selected" : ""}>
              <input
                type="checkbox"
                checked={siteConstraints.walkingOnly}
                onChange={(event) => setSiteConstraints((current) => ({
                  ...current,
                  walkingOnly: event.target.checked,
                }))}
              />
              <span>歩行可能のみ</span>
            </label>
            <label className={subjectObstructionCheckEnabled ? "selected" : ""}>
              <input
                type="checkbox"
                checked={subjectObstructionCheckEnabled}
                onChange={(event) => setSubjectObstructionCheckEnabled(event.target.checked)}
              />
              <span>三脚－被写体間の遮蔽物確認</span>
            </label>
          </div>
          <small className="spot-condition-note">
            「歩行可能のみ」をONにすると、OpenStreetMap登録情報を使って歩行可能と判定できる地点だけを採用します。未登録情報や現地の立入可否は保証対象外です。
          </small>
          <small className="spot-condition-note warning">
            「三脚－被写体間の遮蔽物確認」をONにすると、各候補を3Dデータで追加確認するため検索時間が長くなります。
          </small>
        </fieldset>

        </>}

        <div className="spot-search-action-row">
          <button className="spot-search-submit" type="submit" disabled={isSearching}>
            {isSearching
              ? "検索中…"
              : isPaused && searchDateTime
                ? "新しい構図検索を開始"
                : searchDateTime
                  ? "日時・構図候補を検索"
                  : "被写体を検索して表示"}
          </button>
          {searchDateTime && isSearching && (
            <button
              className="spot-search-pause"
              type="button"
              onClick={() => {
                controllerRef.current?.abort();
                controllerRef.current = null;
                setIsSearching(false);
                setIsPaused(true);
                setMessage("構図検索の待機を一時停止しました。登録済みの検索処理と結果は保持されます。");
              }}
            >
              一時停止
            </button>
          )}
          {searchDateTime && isPaused && !isSearching && (
            <button
              className="spot-search-pause resume"
              type="button"
              onClick={() => {
                const controller = new AbortController();
                controllerRef.current = controller;
                setIsSearching(true);
                setMessage("構図検索を再開しています…");
                void resumeSearchRef.current(controller.signal, (nextMessage, percent) => {
      setMessage(nextMessage);
      setProgressPercent(percent);
    })
                  .then((resumedResults) => {
                    if (controller.signal.aborted) return;
                    if (resumedResults === null) {
                      setMessage("再開できる一時停止中の構図検索がありません");
                      setIsPaused(false);
                      return;
                    }
                    setResults(resumedResults);
                    setMessage(
                      resumedResults.length > 0
                        ? `${resumedResults.length}件の構図候補が見つかりました`
                        : "指定条件で地表上に三脚解を持つ候補は見つかりませんでした"
                    );
                    setIsPaused(false);
                  })
                  .catch((error: unknown) => {
                    if (error instanceof DOMException && error.name === "AbortError") return;
                    setMessage(error instanceof Error ? error.message : "検索の再開に失敗しました");
                  })
                  .finally(() => {
                    if (controllerRef.current === controller) {
                      controllerRef.current = null;
                      setIsSearching(false);
                    }
                  });
              }}
            >
              再開
            </button>
          )}
        </div>

        {searchDateTime && isSearching && (
          <div className="celestial-transit-progress spot-search-progress" role="progressbar" aria-label="スポット検索進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <div className="celestial-transit-progress-track" aria-hidden="true">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <strong>{progressPercent}%</strong>
          </div>
        )}

        {!searchDateTime && message && (
          <p className="spot-search-message" aria-live="polite">{message}</p>
        )}

        {searchDateTime && <section className="spot-search-results" aria-live="polite">
          <div className="spot-search-results-heading">
            <h2>検索結果一覧</h2>
            <label>
              並び順
              <select
                value={resultSort}
                onChange={(event) => setResultSort(event.target.value as SpotResultSort)}
                aria-label="スポット検索結果の並べ替え"
              >
                <option value="date">日付順</option>
                <option value="distance">距離順</option>
              </select>
            </label>
          </div>
          {message && <p className="spot-search-message">{message}</p>}
          {sortedResults.map((result) => (
            <button
              type="button"
              key={result.id}
              className="spot-preset-result"
              onClick={() => setSelectedResult(result)}
            >
              <strong>{resultDateTime(result)}　天体：{result.celestialLabel}</strong>
              <span>{result.placeLabel}</span>
              <small>被写体まで {formatResultDistance(resultDistanceMeters(result))}</small>
              <small>
                {result.focalLengthMm}mm　方位{result.cameraAzimuthDegrees.toFixed(1)}°　仰角{result.cameraAltitudeDegrees.toFixed(1)}°
              </small>
              <small className={`spot-result-3d-status status-${result.candidate3dStatus}`}>
                {candidate3dStatusLabel(result.candidate3dStatus, result.buildingObstructedFractionPercent)}
              </small>
              {result.nearbyLandmarks.length > 0 && (
                <small className="spot-result-landmarks">
                  近隣：{result.nearbyLandmarks.slice(0, 3).map((landmark) =>
                    `${landmark.name} ${landmark.distanceMeters}m`
                  ).join(" / ")}
                </small>
              )}
            </button>
          ))}
          <small className="spot-search-credit">地名検索：© OpenStreetMap contributors</small>
        </section>}
      </form>
    </section>
  );
}
