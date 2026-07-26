import type { SpotSearchDisplayCount } from "../types/search";
import {
  SEARCH_DISPLAY_COUNTS,
  SEARCH_WEEKDAYS,
} from "../search/searchUiPreferences";
import type { SearchTimeRange } from "../search/searchUiPreferences";

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
