export type SearchProgressEstimate = {
  percent: number;
  estimatedRemainingSeconds: number | null;
};

export type SearchProgressEstimator = {
  readonly searchId: number;
  update: (
    searchId: number,
    percent: number,
    nowMilliseconds?: number
  ) => SearchProgressEstimate | null;
  complete: (searchId: number) => SearchProgressEstimate | null;
  cancel: (searchId: number) => void;
};

const MINIMUM_RATE_SAMPLE_MILLISECONDS = 750;
const MAXIMUM_ESTIMATE_SECONDS = 24 * 60 * 60;
const RATE_SMOOTHING_WEIGHT = 0.25;

/** 検索世代ごとに進捗を単調増加させ、進行速度の移動平均から残り時間を求める。 */
export function createSearchProgressEstimator(
  searchId: number,
  startedAtMilliseconds = Date.now()
): SearchProgressEstimator {
  let currentPercent = 0;
  let rateAnchorPercent = 0;
  let rateAnchorMilliseconds = startedAtMilliseconds;
  let smoothedMillisecondsPerPercent: number | null = null;
  let cancelled = false;

  const update = (
    updateSearchId: number,
    rawPercent: number,
    nowMilliseconds = Date.now()
  ): SearchProgressEstimate | null => {
    if (cancelled || updateSearchId !== searchId) return null;
    const bounded = Math.max(0, Math.min(100, Math.round(rawPercent)));
    currentPercent = Math.max(currentPercent, bounded);
    const percentDelta = currentPercent - rateAnchorPercent;
    const elapsedMilliseconds = nowMilliseconds - rateAnchorMilliseconds;
    if (
      currentPercent < 100 &&
      percentDelta > 0 &&
      elapsedMilliseconds >= MINIMUM_RATE_SAMPLE_MILLISECONDS
    ) {
      const measuredMillisecondsPerPercent = elapsedMilliseconds / percentDelta;
      smoothedMillisecondsPerPercent = smoothedMillisecondsPerPercent === null
        ? measuredMillisecondsPerPercent
        : smoothedMillisecondsPerPercent * (1 - RATE_SMOOTHING_WEIGHT) +
          measuredMillisecondsPerPercent * RATE_SMOOTHING_WEIGHT;
      rateAnchorPercent = currentPercent;
      rateAnchorMilliseconds = nowMilliseconds;
    }
    const estimatedRemainingSeconds =
      currentPercent > 0 &&
      currentPercent < 100 &&
      smoothedMillisecondsPerPercent !== null
        ? Math.min(
            MAXIMUM_ESTIMATE_SECONDS,
            Math.max(
              1,
              Math.round(
                smoothedMillisecondsPerPercent * (100 - currentPercent) / 1_000
              )
            )
          )
        : null;
    return { percent: currentPercent, estimatedRemainingSeconds };
  };

  return {
    searchId,
    update,
    complete: (completeSearchId) => update(
      completeSearchId,
      100,
      Date.now()
    ),
    cancel: (cancelSearchId) => {
      if (cancelSearchId === searchId) cancelled = true;
    },
  };
}

export function formatEstimatedRemainingTime(seconds: number): string {
  const bounded = Math.max(1, Math.round(seconds));
  if (bounded < 60) return `約${bounded}秒`;
  const minutes = Math.floor(bounded / 60);
  const remainingSeconds = bounded % 60;
  if (minutes < 60) {
    return remainingSeconds === 0
      ? `約${minutes}分`
      : `約${minutes}分${remainingSeconds}秒`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `約${hours}時間`
    : `約${hours}時間${remainingMinutes}分`;
}
