export type AdaptiveConcurrencyKind = "candidate" | "mesh-los";

type RuntimeNavigator = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
};

function runtimeNavigator(): RuntimeNavigator | null {
  const candidate = globalThis as unknown as { navigator?: RuntimeNavigator };
  return candidate.navigator ?? null;
}

function hardwareConcurrency(): number {
  const navigatorValue = runtimeNavigator();
  if (!navigatorValue) return 4;
  const value = Number(navigatorValue.hardwareConcurrency);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4;
}

function deviceMemoryGb(): number | null {
  const navigatorValue = runtimeNavigator();
  if (!navigatorValue) return null;
  const value = Number(navigatorValue.deviceMemory);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 精度に関係する計算量は変えず、端末の論理CPU数と公開されているメモリ目安から
 * 同時実行数だけを保守的に決定する。ブラウザが値を公開しない場合は安全側へ倒す。
 */
export function adaptiveSearchConcurrency(
  kind: AdaptiveConcurrencyKind,
  calculationMode: "standard" | "pro" = "standard",
): number {
  const cores = hardwareConcurrency();
  const memory = deviceMemoryGb();

  let concurrency = cores >= 12 ? 4 : cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
  if (memory !== null) {
    if (memory <= 3) concurrency = Math.min(concurrency, 1);
    else if (memory <= 5) concurrency = Math.min(concurrency, 2);
  }

  if (calculationMode === "pro") concurrency = Math.max(1, concurrency - 1);
  if (kind === "mesh-los") concurrency = Math.min(concurrency, 3);
  return Math.max(1, concurrency);
}
