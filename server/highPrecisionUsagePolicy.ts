export const HIGH_PRECISION_WARNING_LIMIT = 800;
export const HIGH_PRECISION_STOP_LIMIT = 850;
export const HIGH_PRECISION_SESSION_TTL_SECONDS = 3 * 60 * 60;

export type HighPrecisionUsageDecision = {
  allowed: boolean;
  shouldWarn: boolean;
  reason?: "monthly_limit_reached" | "service_disabled";
};

export function highPrecisionMonthKey(
  date = new Date(),
  timeZone = "America/Los_Angeles"
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("月次キーを生成できませんでした");
  return `${year}-${month}`;
}

/**
 * 新規セッションを作成する前の判定。
 * 849件までは次の1件を許可し、850件に達した時点で以後の新規利用を停止する。
 */
export function decideHighPrecisionBeforeCreate(input: {
  count: number;
  serviceEnabled: boolean;
  limitsEnabled: boolean;
}): HighPrecisionUsageDecision {
  if (!input.serviceEnabled) {
    return { allowed: false, shouldWarn: false, reason: "service_disabled" };
  }
  if (input.limitsEnabled && input.count >= HIGH_PRECISION_STOP_LIMIT) {
    return { allowed: false, shouldWarn: false, reason: "monthly_limit_reached" };
  }
  return {
    allowed: true,
    shouldWarn: input.limitsEnabled && input.count >= HIGH_PRECISION_WARNING_LIMIT,
  };
}

/** セッション作成後または既存セッション再利用時の応答判定。 */
export function decideHighPrecisionAfterCount(input: {
  count: number;
  serviceEnabled: boolean;
  limitsEnabled: boolean;
}): HighPrecisionUsageDecision {
  if (!input.serviceEnabled) {
    return { allowed: false, shouldWarn: false, reason: "service_disabled" };
  }
  return {
    // 850件目そのものは許可済み。次の新規セッションから停止する。
    allowed: !input.limitsEnabled || input.count <= HIGH_PRECISION_STOP_LIMIT,
    shouldWarn: input.limitsEnabled && input.count >= HIGH_PRECISION_WARNING_LIMIT,
    reason:
      input.limitsEnabled && input.count > HIGH_PRECISION_STOP_LIMIT
        ? "monthly_limit_reached"
        : undefined,
  };
}
