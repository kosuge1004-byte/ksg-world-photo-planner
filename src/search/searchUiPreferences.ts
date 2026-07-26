import { useEffect, useState } from "react";

import {
  DEFAULT_SEARCH_END_TIME,
  DEFAULT_SEARCH_START_TIME,
  isValidSearchTime,
} from "./searchTimeRange";
import type { SpotSearchDisplayCount } from "../types/search";

export const SEARCH_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export const SEARCH_DISPLAY_COUNTS: SpotSearchDisplayCount[] = [
  1, 3, 5, 10, 20, 50, 100,
];

const SEARCH_TIME_RANGE_STORAGE_KEY = "ksg-search-time-range-v1";

export type SearchTimeRange = {
  startTime: string;
  endTime: string;
};

function loadSearchTimeRange(): SearchTimeRange {
  if (typeof window === "undefined") {
    return {
      startTime: DEFAULT_SEARCH_START_TIME,
      endTime: DEFAULT_SEARCH_END_TIME,
    };
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SEARCH_TIME_RANGE_STORAGE_KEY) ?? "null"
    ) as Partial<SearchTimeRange> | null;
    if (
      isValidSearchTime(parsed?.startTime ?? "") &&
      isValidSearchTime(parsed?.endTime ?? "")
    ) {
      return {
        startTime: parsed!.startTime!,
        endTime: parsed!.endTime!,
      };
    }
  } catch {
    // 保存値が壊れている場合は初期値へ戻す。
  }
  return {
    startTime: DEFAULT_SEARCH_START_TIME,
    endTime: DEFAULT_SEARCH_END_TIME,
  };
}

export function useSearchTimeRange(): [
  SearchTimeRange,
  (value: SearchTimeRange) => void,
] {
  const [value, setValue] = useState<SearchTimeRange>(loadSearchTimeRange);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SEARCH_TIME_RANGE_STORAGE_KEY,
      JSON.stringify(value)
    );
  }, [value]);
  return [value, setValue];
}
