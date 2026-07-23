import type { SpotSearchDisplayCount } from "../types/search";

export const SEARCH_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export const SEARCH_DISPLAY_COUNTS: SpotSearchDisplayCount[] = [1, 3, 5, 10, 20, 50, 100];

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
