/**
 * 2026-10-16: データサービスにつながらなかった間にCloudflare（D1）へ貯められた
 * 自動登録スポットを受け取り、この端末の登録データへ入れる。
 *
 * - 起動直後に1回、その後は一定間隔（既定1分）で受け取る。
 * - 1回に20件ずつ、残りが無くなるまで（最大10回）続ける。
 * - 登録できた地点だけを「受け取り済み」としてCloudflareから消す。
 *   失敗した地点は残り、次回また受け取る。
 * - 認証は Quick Tunnel の登録と同じトークン（LOCAL_DEM_REGISTRATION_TOKEN）。
 *   トークンが無い起動方法（名前付きトンネル等）では何もしない。
 */
import type { DynamicSpotRegistrationInput, DynamicSpotRecord } from "../../src/types/dynamicSpot.ts";
import { isDynamicSpotRegistrationInput } from "../../src/types/dynamicSpot.ts";

export const PENDING_SPOT_PULL_INTERVAL_MS = 60 * 1_000;
const TAKE_LIMIT = 20;
const MAX_ROUNDS_PER_PULL = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ALLOWED_HOSTNAME = "astrosight.pages.dev";
const DEFAULT_REGISTER_URL = "https://astrosight.pages.dev/api/local-dem-register";

type PendingItem = { coordinateKey: string; input: DynamicSpotRegistrationInput };

export type PendingSpotPullerOptions = {
  registrationToken: string | undefined;
  /** 既存の登録URL（ASTROSIGHT_LOCAL_DEM_REGISTER_URL）。同じサイトの別の入口を使う。 */
  registerUrl?: string;
  register(input: DynamicSpotRegistrationInput): Promise<DynamicSpotRecord>;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export function pendingSpotQueueUrl(registerUrl: string | undefined): URL | null {
  try {
    const base = new URL(registerUrl?.trim() || DEFAULT_REGISTER_URL);
    if (base.protocol !== "https:" || base.hostname !== ALLOWED_HOSTNAME || base.port ||
      base.username || base.password) return null;
    return new URL("/api/dynamic-spot-queue", base.origin);
  } catch {
    return null;
  }
}

function parseItems(value: unknown): PendingItem[] | null {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: PendingItem[] = [];
  for (const item of value.items as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.coordinateKey !== "string" || !isDynamicSpotRegistrationInput(record.input)) continue;
    items.push({ coordinateKey: record.coordinateKey, input: record.input });
  }
  return items;
}

export function createPendingSpotPuller(options: PendingSpotPullerOptions): {
  enabled: boolean;
  pullOnce(): Promise<{ registered: number; failed: number }>;
  start(intervalMs?: number): () => void;
} {
  const token = options.registrationToken?.trim() ?? "";
  const url = pendingSpotQueueUrl(options.registerUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((event, detail) => console.info(JSON.stringify({ event, ...detail })));
  const enabled = token.length >= 32 && url !== null;
  let running = false;

  const call = async (body: unknown): Promise<unknown> => {
    if (!url) throw new Error("queue url unavailable");
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "X-AstroSight-Registration-Token": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`queue HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("queue response too large");
    return JSON.parse(text) as unknown;
  };

  const pullOnce = async (): Promise<{ registered: number; failed: number }> => {
    if (!enabled || running) return { registered: 0, failed: 0 };
    running = true;
    let registered = 0;
    let failed = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS_PER_PULL; round += 1) {
        const items = parseItems(await call({ action: "take", limit: TAKE_LIMIT }));
        if (!items || items.length === 0) break;
        const done: string[] = [];
        for (const item of items) {
          try {
            await options.register(item.input);
            done.push(item.coordinateKey);
            registered += 1;
          } catch {
            failed += 1;
          }
        }
        if (done.length > 0) await call({ action: "ack", coordinateKeys: done });
        // 全部失敗した回はこれ以上続けない（同じ地点を繰り返し受け取るだけになる）。
        if (done.length === 0 || items.length < TAKE_LIMIT) break;
      }
      if (registered > 0 || failed > 0) log("pending-dynamic-spots-pulled", { registered, failed });
    } catch {
      // 通信できないときは次回に回す。トークンや接続先はログに出さない。
      log("pending-dynamic-spots-pull-failed");
    } finally {
      running = false;
    }
    return { registered, failed };
  };

  return {
    enabled,
    pullOnce,
    start(intervalMs = PENDING_SPOT_PULL_INTERVAL_MS) {
      if (!enabled) {
        log("pending-dynamic-spots-pull-disabled");
        return () => undefined;
      }
      void pullOnce();
      const timer = setInterval(() => void pullOnce(), intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
