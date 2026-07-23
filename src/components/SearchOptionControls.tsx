import { useEffect, useState } from "react";

import type { SpotSearchDisplayCount } from "../types/search";
import {
  DEFAULT_SEARCH_END_TIME,
  DEFAULT_SEARCH_START_TIME,
  isValidSearchTime,
} from "../search/searchTimeRange";

export const SEARCH_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export const SEARCH_DISPLAY_COUNTS: SpotSearchDisplayCount[] = [1, 3, 5, 10, 20, 50, 100];

const SEARCH_TIME_RANGE_STORAGE_KEY = "ksg-search-time-range-v1";

export type SearchTimeRange = {
  startTime: string;
  endTime: string;
};

function loadSearchTimeRange(): SearchTimeRange {
  if (typeof window === "undefined") {
    return { startTime: DEFAULT_SEARCH_START_TIME, endTime: DEFAULT_SEARCH_END_TIME };
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SEARCH_TIME_RANGE_STORAGE_KEY) ?? "null"
    ) as Partial<SearchTimeRange> | null;
    if (isValidSearchTime(parsed?.startTime ?? "") && isValidSearchTime(parsed?.endTime ?? "")) {
      return { startTime: parsed!.startTime!, endTime: parsed!.endTime! };
    }
  } catch {
    // 保存値が壊れている場合は初期値へ戻す。
  }
  return { startTime: DEFAULT_SEARCH_START_TIME, endTime: DEFAULT_SEARCH_END_TIME };
}

export function useSearchTimeRange(): [SearchTimeRange, (value: SearchTimeRange) => void] {
  const [value, setValue] = useState<SearchTimeRange>(loadSearchTimeRange);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SEARCH_TIME_RANGE_STORAGE_KEY, JSON.stringify(value));
  }, [value]);
  return [value, setValue];
}

type WeekdaySelectorProps = {
  weekdays: number[];
  onChange: (weekdays: number[]) => void;
};

export function WeekdaySelector({ weekdays, onChange }: WeekdaySelectorProps) {
  return (
    <fieldset className="spot-search-group">
      <legend>曜日選択</legend>
      <div className="spot-weekday-grid">
        {SEARCH_WEEKDAYS.map((label, weekday) => {
          const selected = weekdays.includes(weekday);
          return (
            <label key={label} className={selected ? "selected" : ""}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onChange(
                  selected
                    ? weekdays.filter((value) => value !== weekday)
                    : [...weekdays, weekday].sort((left, right) => left - right)
                )}
              />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
      <small className="spot-weekday-note">未選択は全曜日を検索します</small>
    </fieldset>
  );
}

type TimeRangeSelectorProps = SearchTimeRange & {
  onChange: (value: SearchTimeRange) => void;
};

export function TimeRangeSelector({ startTime, endTime, onChange }: TimeRangeSelectorProps) {
  return (
    <fieldset className="spot-search-group">
      <legend>時間帯</legend>
      <div className="spot-custom-period spot-time-range">
        <label>
          <span>開始</span>
          <input
            type="time"
            step={60}
            value={startTime}
            onChange={(event) => onChange({ startTime: event.target.value, endTime })}
          />
        </label>
        <label>
          <span>終了</span>
          <input
            type="time"
            step={60}
            value={endTime}
            onChange={(event) => onChange({ startTime, endTime: event.target.value })}
          />
        </label>
      </div>
      <small className="spot-weekday-note">開始が終了より後の場合は日付またぎで検索します</small>
    </fieldset>
  );
}

type DisplayCountSelectProps = {
  value: SpotSearchDisplayCount;
  onChange: (value: SpotSearchDisplayCount) => void;
};

export function DisplayCountSelect({ value, onChange }: DisplayCountSelectProps) {
  return (
    <label className="spot-search-field">
      <span>表示件数</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as SpotSearchDisplayCount)}
      >
        {SEARCH_DISPLAY_COUNTS.map((count) => (
          <option key={count} value={count}>{count}件</option>
        ))}
      </select>
    </label>
  );
}
