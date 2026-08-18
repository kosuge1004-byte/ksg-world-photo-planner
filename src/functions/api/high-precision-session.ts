import type { CloudflareEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";

const WARNING_LIMIT = 800;
const STOP_LIMIT = 850;
const SESSION_TTL_SECONDS = 3 * 60 * 60;
const USAGE_KEY_PREFIX = "high-precision-usage:";
const WARNING_KEY_PREFIX = "high-precision-warning:";

interface HighPrecisionEnv extends CloudflareEnv {
  HIGH_PRECISION_ALERT_WEBHOOK_URL?: string;
  HIGH_PRECISION_LIMITS_ENABLED?: string;
}

function pacificMonthKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("月次キーを生成できませんでした");
  return `${year}-${month}`;
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
    console.warn(`[high-precision] ${monthKey}: ${count} sessions (warning threshold ${WARNING_LIMIT})`);
    return;
  }

  context.waitUntil(fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `AstroSight高精度モードが月間${count}イベントに到達しました。${STOP_LIMIT}イベントで自動停止します。`,
      month: monthKey,
      count,
      warningLimit: WARNING_LIMIT,
      stopLimit: STOP_LIMIT,
    }),
  }).then(() => undefined).catch((error) => {
    console.error("High precision warning webhook failed", error);
  }));
}

export const onRequestGet: PagesFunction<HighPrecisionEnv> = async (context) => {
  const monthKey = pacificMonthKey();
  const count = await countMonthlySessions(context.env.SPOT_SEARCH_JOBS, monthKey);
  const limitsEnabled = context.env.HIGH_PRECISION_LIMITS_ENABLED !== "false";
  return jsonResponse({
    allowed: !limitsEnabled || count < STOP_LIMIT,
    count,
    warningLimit: WARNING_LIMIT,
    stopLimit: STOP_LIMIT,
    month: monthKey,
    limitsEnabled,
  });
};

export const onRequestPost: PagesFunction<HighPrecisionEnv> = async (context) => {
  const limitsEnabled = context.env.HIGH_PRECISION_LIMITS_ENABLED !== "false";
  const body = await context.request.json().catch(() => ({})) as { sessionId?: unknown };
  const sessionId = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(body.sessionId)
    ? body.sessionId
    : crypto.randomUUID().replaceAll("-", "");
  const monthKey = pacificMonthKey();
  const sessionKey = `${USAGE_KEY_PREFIX}${monthKey}:${sessionId}`;

  const existing = await context.env.SPOT_SEARCH_JOBS.get(sessionKey);
  let count = await countMonthlySessions(context.env.SPOT_SEARCH_JOBS, monthKey);

  if (!existing) {
    if (limitsEnabled && count >= STOP_LIMIT) {
      return jsonResponse({
        allowed: false,
        reason: "monthly_limit_reached",
        count,
        warningLimit: WARNING_LIMIT,
        stopLimit: STOP_LIMIT,
        month: monthKey,
      }, 429);
    }

    await context.env.SPOT_SEARCH_JOBS.put(sessionKey, new Date().toISOString(), {
      expirationTtl: 40 * 24 * 60 * 60,
    });
    count += 1;
  }

  if (limitsEnabled && count >= WARNING_LIMIT) {
    await sendWarningOnce(context, monthKey, count);
  }

  return jsonResponse({
    allowed: !limitsEnabled || count <= STOP_LIMIT,
    sessionId,
    reused: Boolean(existing),
    count,
    warningLimit: WARNING_LIMIT,
    stopLimit: STOP_LIMIT,
    month: monthKey,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    limitsEnabled,
  });
};
