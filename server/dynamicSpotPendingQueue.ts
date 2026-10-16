/**
 * 2026-10-16: パソコンのデータサービスにつながらなかった間の自動登録スポットを、
 * CloudflareのD1に一時的に貯めておく。パソコン側が起動時と一定間隔で受け取り
 * （take）、自分の登録データへ入れた後で消す（ack）。
 *
 * - 同じ地点（座標キー）は1行にまとめる（後から来た登録内容で上書き）。
 * - 行数に上限を設け、無料枠と保存量を守る。上限に達したら新しい地点は貯めない。
 * - テーブルは初回に自動で作る（手作業のmigration不要）。
 */
import {
  dynamicSpotCoordinateKey,
  isDynamicSpotRegistrationInput,
  type DynamicSpotRegistrationInput,
} from "../src/types/dynamicSpot.ts";

export const DYNAMIC_SPOT_PENDING_MAX_ROWS = 2_000;
export const DYNAMIC_SPOT_PENDING_TAKE_MAX = 20;

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
};

/** D1Databaseのうち、ここで使う部分だけ（テストでモックしやすくするため）。 */
export type DynamicSpotPendingDb = {
  exec?(query: string): Promise<unknown>;
  prepare(query: string): D1Statement;
};

export type DynamicSpotPendingItem = {
  coordinateKey: string;
  queuedAt: string;
  input: DynamicSpotRegistrationInput;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS dynamic_spot_pending (
  coordinate_key TEXT PRIMARY KEY,
  input_json TEXT NOT NULL,
  queued_at TEXT NOT NULL
)`;

const tableReady = new WeakMap<object, Promise<void>>();

async function ensureTable(db: DynamicSpotPendingDb): Promise<void> {
  const identity = db as object;
  let pending = tableReady.get(identity);
  if (!pending) {
    pending = (db.exec
      ? db.exec(CREATE_TABLE.replace(/\s+/gu, " "))
      : db.prepare(CREATE_TABLE).run()
    ).then(() => undefined);
    pending.catch(() => tableReady.delete(identity));
    tableReady.set(identity, pending);
  }
  return pending;
}

/**
 * 1件貯める。戻り値: "queued"（新規・上書き）/ "full"（上限で貯めなかった）。
 */
export async function enqueueDynamicSpotRegistration(
  db: DynamicSpotPendingDb,
  input: DynamicSpotRegistrationInput,
  now = new Date()
): Promise<"queued" | "full"> {
  if (!isDynamicSpotRegistrationInput(input)) throw new Error("登録内容が不正です");
  await ensureTable(db);
  const coordinateKey = dynamicSpotCoordinateKey(input.latitude, input.longitude);
  const inputJson = JSON.stringify(input);
  // 既にある地点は上書き（行数は増えない）。新しい地点は上限未満のときだけ入れる。
  const result = await db.prepare(
    `INSERT INTO dynamic_spot_pending (coordinate_key, input_json, queued_at)
     SELECT ?1, ?2, ?3
     WHERE EXISTS (SELECT 1 FROM dynamic_spot_pending WHERE coordinate_key = ?1)
        OR (SELECT COUNT(*) FROM dynamic_spot_pending) < ?4
     ON CONFLICT(coordinate_key) DO UPDATE SET input_json = excluded.input_json
     RETURNING coordinate_key`
  ).bind(coordinateKey, inputJson, now.toISOString(), DYNAMIC_SPOT_PENDING_MAX_ROWS)
    .first<{ coordinate_key: string }>();
  return result ? "queued" : "full";
}

/** 古い順に最大limit件を返す（消さない。受け取った側がackで消す）。 */
export async function takeDynamicSpotRegistrations(
  db: DynamicSpotPendingDb,
  limit = DYNAMIC_SPOT_PENDING_TAKE_MAX
): Promise<DynamicSpotPendingItem[]> {
  await ensureTable(db);
  const size = Math.max(1, Math.min(DYNAMIC_SPOT_PENDING_TAKE_MAX, Math.floor(limit)));
  const rows = await db.prepare(
    `SELECT coordinate_key, input_json, queued_at FROM dynamic_spot_pending
     ORDER BY queued_at ASC, coordinate_key ASC LIMIT ?1`
  ).bind(size).all<{ coordinate_key: string; input_json: string; queued_at: string }>();
  const items: DynamicSpotPendingItem[] = [];
  const broken: string[] = [];
  for (const row of rows.results ?? []) {
    let input: unknown = null;
    try {
      input = JSON.parse(row.input_json) as unknown;
    } catch {
      input = null;
    }
    if (isDynamicSpotRegistrationInput(input)) {
      items.push({ coordinateKey: row.coordinate_key, queuedAt: row.queued_at, input });
    } else {
      broken.push(row.coordinate_key);
    }
  }
  // 読めない行は二度と使えないので、ここで消す（残すと毎回の受け取りを邪魔する）。
  if (broken.length > 0) await acknowledgeDynamicSpotRegistrations(db, broken);
  return items;
}

/** 受け取り済みの地点を消す。 */
export async function acknowledgeDynamicSpotRegistrations(
  db: DynamicSpotPendingDb,
  coordinateKeys: readonly string[]
): Promise<number> {
  await ensureTable(db);
  let removed = 0;
  for (const key of coordinateKeys.slice(0, DYNAMIC_SPOT_PENDING_TAKE_MAX)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 64) continue;
    await db.prepare("DELETE FROM dynamic_spot_pending WHERE coordinate_key = ?1").bind(key).run();
    removed += 1;
  }
  return removed;
}
