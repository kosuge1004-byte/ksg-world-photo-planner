// 2026-10-16: 自動登録スポットの「登録スポット候補」月別一覧と、
// データサービスにつながらない間の登録をD1へ貯めて後で受け取る仕組み。
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { dynamicSpotCoordinateKey } from "../../src/types/dynamicSpot.ts";
import { createDynamicSpotStore } from "../../tools/local-dem-server/dynamicSpotStore.ts";
import {
  createSpotCandidateListWriter,
  formatSpotCandidateMonth,
  spotCandidateDirectory,
  spotCandidateFileName,
  spotCandidateMonthKey,
} from "../../tools/local-dem-server/spotCandidateList.ts";
import {
  DYNAMIC_SPOT_PENDING_MAX_ROWS,
  acknowledgeDynamicSpotRegistrations,
  enqueueDynamicSpotRegistration,
  takeDynamicSpotRegistrations,
} from "../../server/dynamicSpotPendingQueue.ts";
import { handleDynamicSpotApi } from "../../functions/_shared/dynamicSpotApi.ts";
import { onRequest as queueEndpoint } from "../../functions/api/dynamic-spot-queue.ts";
import { createPendingSpotPuller, pendingSpotQueueUrl } from "../../tools/local-dem-server/pendingSpotPuller.ts";

function input(overrides = {}) {
  return {
    name: "未登録テスト地点",
    aliases: ["動的地点"],
    latitude: 35.1234567,
    longitude: 136.7654321,
    category: "tower",
    subjectSurface: "structure",
    structureHeightMeters: 138,
    heightSourceType: "official",
    heightSourceUrl: "https://example.jp/tower",
    heightSourceLabel: "公式サイト",
    heightStatus: "verified",
    maxDistanceMeters: 10_000,
    bearingCount: 360,
    ...overrides,
  };
}

function record(overrides = {}) {
  const base = input(overrides);
  return {
    schemaVersion: 1,
    id: "dynamic-test",
    ...base,
    demProfileStatus: "pending",
    createdAt: "2026-10-16T00:30:00.000Z",
    updatedAt: "2026-10-16T00:30:00.000Z",
    coordinateKey: dynamicSpotCoordinateKey(base.latitude, base.longitude),
    profileVersion: "bearing-profile-v1-10km-360",
    ...overrides,
  };
}

function successfulCompute() {
  return async (request) => {
    const distancesMeters = [8, 1_000, 10_000];
    return {
      version: 2,
      terrainProfileComplete: true,
      distancesMeters,
      profiles: request.bearings.map((bearing) => ({
        bearingDegrees: bearing,
        ellipsoidalHeightsMeters: distancesMeters.map(() => 30),
        elevationSources: distancesMeters.map(() => "DEM5A"),
        computedAtIso: new Date().toISOString(),
      })),
      failedBearings: [],
      requestedBearingCount: request.bearings.length,
      pointCount: request.bearings.length * distancesMeters.length,
    };
  };
}

/** node:sqlite を D1 と同じ呼び方（prepare().bind().run/first/all）で包む。 */
function sqliteD1() {
  const database = new DatabaseSync(":memory:");
  return {
    database,
    async exec(sql) { database.exec(sql); },
    prepare(sql) {
      const statement = database.prepare(sql);
      let values = [];
      const bound = {
        bind(...next) { values = next; return bound; },
        async run() { return statement.run(...values); },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
      };
      return bound;
    },
  };
}

test("monthly list: JST month, bullet format, unknown height is flagged", () => {
  // 2026-09-30 15:30 UTC は日本時間 10月1日 0:30 → 10月の一覧
  assert.equal(spotCandidateMonthKey({ createdAt: "2026-09-30T15:30:00.000Z" }), "202610");
  assert.equal(spotCandidateMonthKey({ createdAt: "2026-09-30T14:59:00.000Z" }), "202609");
  assert.equal(spotCandidateFileName("202610"), "登録スポット202610一覧.txt");
  const text = formatSpotCandidateMonth("202610", [
    record({ name: "高さ不明の塔", latitude: 35.2, structureHeightMeters: null, heightStatus: "unknown",
      heightSourceType: "unknown", heightSourceUrl: null, heightSourceLabel: null, createdAt: "2026-10-18T12:05:00.000Z" }),
    record({ name: "○○タワー", aliases: ["○○タワー", "○○塔"] }),
    record({ name: "△△山", latitude: 35.3, category: "mountain", subjectSurface: "terrain", structureHeightMeters: 0,
      heightSourceType: "unknown", heightSourceUrl: null, heightSourceLabel: null, heightStatus: "unknown",
      createdAt: "2026-10-20T03:00:00.000Z" }),
  ]);
  const lines = text.split("\r\n");
  assert.equal(lines[0], "登録スポット候補 2026年10月（3件）");
  // 登録日時の古い順
  assert.deepEqual(lines.filter((line) => line.startsWith("■ ")), ["■ ○○タワー", "■ 高さ不明の塔", "■ △△山"]);
  assert.ok(lines.includes("・登録日時：2026-10-16 09:30"));
  assert.ok(lines.includes("・別名：○○塔"));
  assert.ok(lines.includes("・座標：35.1234567, 136.7654321"));
  assert.ok(lines.includes("・種類：塔（構造物）"));
  assert.ok(lines.includes("・高さ：138m（確認済み）"));
  assert.ok(lines.includes("・高さの出典：公式サイト （公式） https://example.jp/tower"));
  assert.ok(lines.includes("・高さ：不明（要確認）"));
  assert.ok(lines.includes("・種類：山（地表）"));
  assert.ok(lines.includes("・高さ：0m（地表）"));
});

test("store writes the month list on registration and rewrites all months at start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astrosight-candidates-"));
  let writer = null;
  const store = await createDynamicSpotStore(root, successfulCompute(), {
    onRecordPersisted: (changed, records) => writer?.writeMonthOf(changed, records),
  });
  writer = createSpotCandidateListWriter(store.root);
  await store.register(input({ name: "一つ目" }));
  await store.register(input({ name: "二つ目", latitude: 35.5 }));
  await store.register(input({ name: "一つ目", aliases: ["一つ目の別名"] })); // 同じ地点の再登録
  const directory = spotCandidateDirectory(store.root);
  assert.equal(directory, path.resolve(store.root, "..", "登録スポット候補"));
  const month = spotCandidateMonthKey({ createdAt: new Date().toISOString() });
  const filePath = path.join(directory, `登録スポット${month}一覧.txt`);
  // 書き込みは保存の後に続けて行われるので、少し待つ
  let text = "";
  for (let i = 0; i < 100; i += 1) {
    try { text = await readFile(filePath, "utf8"); } catch { text = ""; }
    if (text.includes("二つ目") && text.includes("一つ目の別名")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(text.startsWith("﻿登録スポット候補 "), "BOM付きUTF-8");
  assert.ok(text.includes("\r\n"), "CRLF");
  assert.equal(text.split("■ 一つ目").length - 1, 1, "同じ地点は1回だけ");
  assert.equal(text.split("■ 二つ目").length - 1, 1);

  // 起動時の全月書き直し（ファイルを消しても作り直される）
  const freshWriter = createSpotCandidateListWriter(store.root);
  await freshWriter.writeAll(store.listRecords());
  assert.deepEqual(await readdir(directory).then((names) => names.filter((name) => name.endsWith(".txt"))),
    [`登録スポット${month}一覧.txt`]);
});

test("pending queue: one row per place, oldest first, ack removes, broken rows are dropped, cap is enforced", async () => {
  const db = sqliteD1();
  assert.equal(await enqueueDynamicSpotRegistration(db, input(), new Date("2026-10-16T00:00:00Z")), "queued");
  assert.equal(await enqueueDynamicSpotRegistration(db, input({ name: "同じ地点・新しい名前" }), new Date("2026-10-16T00:05:00Z")), "queued");
  assert.equal(await enqueueDynamicSpotRegistration(db, input({ latitude: 35.9 }), new Date("2026-10-16T00:01:00Z")), "queued");
  let items = await takeDynamicSpotRegistrations(db);
  assert.equal(items.length, 2);
  assert.equal(items[0].input.name, "同じ地点・新しい名前", "同じ地点は上書き、最初の登録時刻の順");
  db.database.prepare("INSERT INTO dynamic_spot_pending VALUES ('broken', '{', '2000-01-01T00:00:00Z')").run();
  items = await takeDynamicSpotRegistrations(db);
  assert.equal(items.length, 2, "壊れた行は返さない");
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM dynamic_spot_pending").get().n, 2, "壊れた行は消える");
  await acknowledgeDynamicSpotRegistrations(db, [items[0].coordinateKey]);
  assert.equal((await takeDynamicSpotRegistrations(db)).length, 1);

  const insert = db.database.prepare("INSERT INTO dynamic_spot_pending VALUES (?, ?, ?)");
  for (let i = 0; i < DYNAMIC_SPOT_PENDING_MAX_ROWS; i += 1) insert.run(`fill-${i}`, JSON.stringify(input()), "2026-10-17T00:00:00Z");
  assert.equal(await enqueueDynamicSpotRegistration(db, input({ latitude: 36.1 })), "full", "上限を超える新しい地点は貯めない");
  assert.equal(await enqueueDynamicSpotRegistration(db, input({ latitude: 35.9, name: "既存は更新可" })), "queued");
});

test("register API stores the registration in D1 when the data service is unreachable", async () => {
  const db = sqliteD1();
  const response = await handleDynamicSpotApi({
    request: new Request("https://astrosight.pages.dev/api/dynamic-spot-register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    }),
    env: { R2_WRITE_BUDGET_DB: db },
    waitUntil() {},
  }, "register");
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "LOCAL_DYNAMIC_SPOT_QUEUED");
  assert.equal(body.queued, true);
  assert.equal((await takeDynamicSpotRegistrations(db)).length, 1);
});

test("queue endpoint requires the registration token and supports take/ack", async () => {
  const db = sqliteD1();
  await enqueueDynamicSpotRegistration(db, input());
  const token = "t".repeat(40);
  const call = (body, header = token) => queueEndpoint({
    request: new Request("https://astrosight.pages.dev/api/dynamic-spot-queue", {
      method: "POST",
      headers: { "content-type": "application/json", "X-AstroSight-Registration-Token": header },
      body: JSON.stringify(body),
    }),
    env: { R2_WRITE_BUDGET_DB: db, LOCAL_DEM_REGISTRATION_TOKEN: token },
  });
  assert.equal((await call({ action: "take" }, "x".repeat(40))).status, 401);
  const taken = await (await call({ action: "take" })).json();
  assert.equal(taken.items.length, 1);
  const acked = await (await call({ action: "ack", coordinateKeys: [taken.items[0].coordinateKey] })).json();
  assert.equal(acked.removed, 1);
  assert.equal((await (await call({ action: "take" })).json()).items.length, 0);
});

test("data-service puller registers queued spots and acknowledges only the successful ones", async () => {
  const token = "t".repeat(40);
  const queue = [
    { coordinateKey: "a", input: input({ name: "成功" }) },
    { coordinateKey: "b", input: input({ name: "失敗", latitude: 35.6 }) },
  ];
  const acked = [];
  const fakeFetch = async (url, init) => {
    assert.equal(String(url), "https://astrosight.pages.dev/api/dynamic-spot-queue");
    assert.equal(init.headers["X-AstroSight-Registration-Token"], token);
    const body = JSON.parse(init.body);
    if (body.action === "take") return new Response(JSON.stringify({ items: acked.length ? [] : queue }));
    acked.push(...body.coordinateKeys);
    return new Response(JSON.stringify({ removed: body.coordinateKeys.length }));
  };
  const registered = [];
  const puller = createPendingSpotPuller({
    registrationToken: token,
    registerUrl: "https://astrosight.pages.dev/api/local-dem-register",
    fetchImpl: fakeFetch,
    log: () => {},
    register: async (value) => {
      if (value.name === "失敗") throw new Error("disk");
      registered.push(value.name);
      return value;
    },
  });
  assert.equal(puller.enabled, true);
  assert.deepEqual(await puller.pullOnce(), { registered: 1, failed: 1 });
  assert.deepEqual(registered, ["成功"]);
  assert.deepEqual(acked, ["a"]);

  assert.equal(createPendingSpotPuller({ registrationToken: undefined, register: async () => ({}) }).enabled, false);
  assert.equal(pendingSpotQueueUrl("https://evil.example/api/local-dem-register"), null);
});
