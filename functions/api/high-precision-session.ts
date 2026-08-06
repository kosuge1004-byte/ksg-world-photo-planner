import type { CloudflareEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import {
  HIGH_PRECISION_SESSION_TTL_SECONDS,
  HIGH_PRECISION_STOP_LIMIT,
  HIGH_PRECISION_WARNING_LIMIT,
  decideHighPrecisionAfterCount,
  decideHighPrecisionBeforeCreate,
  highPrecisionMonthKey,
} from "../../server/highPrecisionUsagePolicy.ts";
const USAGE_KEY_PREFIX = "high-precision-usage:";
const WARNING_KEY_PREFIX = "high-precision-warning:";

interface HighPrecisionEnv extends CloudflareEnv {
  HIGH_PRECISION_ALERT_WEBHOOK_URL?: string;
  HIGH_PRECISION_LIMITS_ENABLED?: string;
  HIGH_PRECISION_ENABLED?: string;
}

async function countMonthlySessions(kv: KVNamespace, monthKey: string): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  const prefix = `${USAGE_KEY_PREFIX}${monthKey}:`;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

async function sendWarningOnce(
  context: EventContext<HighPrecisionEnv, string, unknown>,
  monthKey: string,
  count: number
): Promise<void> {
  const warningKey = `${WARNING_KEY_PREFIX}${monthKey}`;
  if (await context.env.SPOT_SEARCH_JOBS.get(warningKey)) return;

  await context.env.SPOT_SEARCH_JOBS.put(warningKey, String(count), {
    expirationTtl: 40 * 24 * 60 * 60,
  });

  const webhookUrl = context.env.HIGH_PRECISION_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(`[high-precision] ${monthKey}: ${count} sessions (warning threshold ${HIGH_PRECISION_WARNING_LIMIT})`);
    return;
  }

  context.waitUntil(fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `AstroSight高精度モードが月間${count}イベントに到達しました。${HIGH_PRECISION_STOP_LIMIT}イベントで自動停止します。`,
      month: monthKey,
      count,
      warningLimit: HIGH_PRECISION_WARNING_LIMIT,
      stopLimit: HIGH_PRECISION_STOP_LIMIT,
    }),
  }).then(() => undefined).catch((error) => {
    console.error("High precision warning webhook failed", error);
  }));
}

export const onRequestGet: PagesFunction<HighPrecisionEnv> = async (context) => {
  const monthKey = highPrecisionMonthKey();
  const count = await countMonthlySessions(context.env.SPOT_SEARCH_JOBS, monthKey);
  const limitsEnabled = context.env.HIGH_PRECISION_LIMITS_ENABLED !== "false";
  const serviceEnabled = context.env.HIGH_PRECISION_ENABLED !== "false";
  const decision = decideHighPrecisionBeforeCreate({ count, serviceEnabled, limitsEnabled });
  return jsonResponse({
    allowed: decision.allowed,
    reason: decision.reason,
    count,
    warningLimit: HIGH_PRECISION_WARNING_LIMIT,
    stopLimit: HIGH_PRECISION_STOP_LIMIT,
    month: monthKey,
    limitsEnabled,
    serviceEnabled,
  });
};

export const onRequestPost: PagesFunction<HighPrecisionEnv> = async (context) => {
  const limitsEnabled = context.env.HIGH_PRECISION_LIMITS_ENABLED !== "false";
  const serviceEnabled = context.env.HIGH_PRECISION_ENABLED !== "false";
  const body = await context.request.json().catch(() => ({})) as { sessionId?: unknown };
  const sessionId = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(body.sessionId)
    ? body.sessionId
    : crypto.randomUUID().replaceAll("-", "");
  const monthKey = highPrecisionMonthKey();
  const sessionKey = `${USAGE_KEY_PREFIX}${monthKey}:${sessionId}`;

  const existing = await context.env.SPOT_SEARCH_JOBS.get(sessionKey);
  let count = await countMonthlySessions(context.env.SPOT_SEARCH_JOBS, monthKey);

  if (!existing) {
    const beforeCreate = decideHighPrecisionBeforeCreate({
      count,
      serviceEnabled,
      limitsEnabled,
    });
    if (!beforeCreate.allowed) {
      return jsonResponse({
        allowed: false,
        reason: beforeCreate.reason,
        count,
        warningLimit: HIGH_PRECISION_WARNING_LIMIT,
        stopLimit: HIGH_PRECISION_STOP_LIMIT,
        month: monthKey,
        limitsEnabled,
        serviceEnabled,
      }, beforeCreate.reason === "service_disabled" ? 503 : 429);
    }

    await context.env.SPOT_SEARCH_JOBS.put(sessionKey, new Date().toISOString(), {
      expirationTtl: 40 * 24 * 60 * 60,
    });
    count += 1;
  }

  const afterCount = decideHighPrecisionAfterCount({ count, serviceEnabled, limitsEnabled });
  if (afterCount.shouldWarn) {
    await sendWarningOnce(context, monthKey, count);
  }

  return jsonResponse({
    allowed: afterCount.allowed,
    reason: afterCount.reason,
    sessionId,
    reused: Boolean(existing),
    count,
    warningLimit: HIGH_PRECISION_WARNING_LIMIT,
    stopLimit: HIGH_PRECISION_STOP_LIMIT,
    month: monthKey,
    sessionTtlSeconds: HIGH_PRECISION_SESSION_TTL_SECONDS,
    limitsEnabled,
    serviceEnabled,
  });
};
