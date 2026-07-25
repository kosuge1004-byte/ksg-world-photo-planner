export type SpotSearchPerformanceMetrics = {
  version: 1;
  startedAtIso: string;
  totalMilliseconds: number;
  phaseMilliseconds: Partial<Record<number, number>>;
  counters: {
    generatedSamples: number;
    checkedSamples: number;
    celestialMatches: number;
    terrainPrefetches: number;
    terrainPrefetchFailures: number;
    candidateAttempts: number;
    candidateFailures: number;
    candidateAccepted: number;
    lineOfSightChecks: number;
    lineOfSightVisible: number;
    lineOfSightFailures: number;
    lineOfSightUnverifiedAccepted: number;
    siteContextRequests: number;
    resultCount: number;
  };
  operationMilliseconds: {
    terrainPrefetch: number;
    candidateSearch: number;
    lineOfSight: number;
    siteContext: number;
  };
};

type CounterName = keyof SpotSearchPerformanceMetrics["counters"];
type OperationName = keyof SpotSearchPerformanceMetrics["operationMilliseconds"];

export type SpotSearchPerformanceTracker = {
  enterPhase: (phaseId: number) => void;
  increment: (name: CounterName, amount?: number) => void;
  measure: <T>(name: OperationName, operation: () => Promise<T>) => Promise<T>;
  snapshot: (resultCount?: number) => SpotSearchPerformanceMetrics;
  complete: (resultCount: number) => SpotSearchPerformanceMetrics;
};

export function createSpotSearchPerformanceTracker(): SpotSearchPerformanceTracker {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const phaseMilliseconds: Partial<Record<number, number>> = {};
  const counters: SpotSearchPerformanceMetrics["counters"] = {
    generatedSamples: 0,
    checkedSamples: 0,
    celestialMatches: 0,
    terrainPrefetches: 0,
    terrainPrefetchFailures: 0,
    candidateAttempts: 0,
    candidateFailures: 0,
    candidateAccepted: 0,
    lineOfSightChecks: 0,
    lineOfSightVisible: 0,
    lineOfSightFailures: 0,
    lineOfSightUnverifiedAccepted: 0,
    siteContextRequests: 0,
    resultCount: 0,
  };
  const operationMilliseconds: SpotSearchPerformanceMetrics["operationMilliseconds"] = {
    terrainPrefetch: 0,
    candidateSearch: 0,
    lineOfSight: 0,
    siteContext: 0,
  };
  let currentPhase: number | null = null;
  let phaseStartedAt = startedAt;

  const closeCurrentPhase = (now: number): void => {
    if (currentPhase === null) return;
    phaseMilliseconds[currentPhase] = (phaseMilliseconds[currentPhase] ?? 0) +
      Math.max(0, now - phaseStartedAt);
  };

  return {
    enterPhase(phaseId) {
      const now = Date.now();
      if (currentPhase === phaseId) return;
      closeCurrentPhase(now);
      currentPhase = phaseId;
      phaseStartedAt = now;
    },
    increment(name, amount = 1) {
      counters[name] += amount;
    },
    async measure(name, operation) {
      const start = Date.now();
      try {
        return await operation();
      } finally {
        operationMilliseconds[name] += Math.max(0, Date.now() - start);
      }
    },
    snapshot(resultCount = counters.resultCount) {
      const now = Date.now();
      const snapshotPhases = { ...phaseMilliseconds };
      if (currentPhase !== null) {
        snapshotPhases[currentPhase] = (snapshotPhases[currentPhase] ?? 0) +
          Math.max(0, now - phaseStartedAt);
      }
      return {
        version: 1,
        startedAtIso,
        totalMilliseconds: Math.max(0, now - startedAt),
        phaseMilliseconds: snapshotPhases,
        counters: { ...counters, resultCount },
        operationMilliseconds: { ...operationMilliseconds },
      };
    },
    complete(resultCount) {
      const finishedAt = Date.now();
      closeCurrentPhase(finishedAt);
      currentPhase = null;
      counters.resultCount = resultCount;
      return {
        version: 1,
        startedAtIso,
        totalMilliseconds: Math.max(0, finishedAt - startedAt),
        phaseMilliseconds: { ...phaseMilliseconds },
        counters: { ...counters },
        operationMilliseconds: { ...operationMilliseconds },
      };
    },
  };
}

export function formatSearchDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}分${seconds}秒`;
}
