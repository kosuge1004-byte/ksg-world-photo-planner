import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  R2_MONTHLY_READ_BUDGET,
  R2_MONTHLY_WRITE_BUDGET,
  R2_STORAGE_RESERVATION_BUDGET_BYTES,
  allowR2Read,
  reserveR2Write,
} from "../server/r2SafetyBudget.ts";
import {
  ACTIVE_PREWARM_LANDMARKS,
  PREWARM_LANDMARKS,
} from "../server/landmarkPrewarmSeed.ts";

class MemoryBudgetDb {
  values = new Map();
  fail = false;

  prepare() {
    return {
      bind: (key, increment, limit) => ({
        first: async () => {
          if (this.fail) throw new Error("simulated D1 failure");
          const current = this.values.get(key) ?? 0;
          if (current + increment > limit) return null;
          const writes = current + increment;
          this.values.set(key, writes);
          return { writes };
        },
      }),
    };
  }
}

class MissingTableBudgetDb extends MemoryBudgetDb {
  tableExists = false;
  execCount = 0;

  async exec(query) {
    assert.match(query, /CREATE TABLE IF NOT EXISTS r2_write_budget/);
    this.execCount += 1;
    this.tableExists = true;
  }

  prepare() {
    return {
      bind: (key, increment, limit) => ({
        first: async () => {
          if (!this.tableExists) throw new Error("no such table: r2_write_budget");
          const current = this.values.get(key) ?? 0;
          if (current + increment > limit) return null;
          const writes = current + increment;
          this.values.set(key, writes);
          return { writes };
        },
      }),
    };
  }
}

const kv = { async get() { return null; }, async put() {} };
const month = new Date().toISOString().slice(0, 7);

assert.equal(await allowR2Read(kv, {}, undefined), false, "missing D1 must fail closed");
const readDb = new MemoryBudgetDb();
assert.equal(await allowR2Read(kv, {}, readDb), true);
const missingTableDb = new MissingTableBudgetDb();
assert.equal(await allowR2Read(kv, {}, missingTableDb), true,
  "a missing D1 migration must self-initialize instead of disabling R2");
assert.equal(missingTableDb.execCount, 1);
readDb.values.set(`read:${month}`, R2_MONTHLY_READ_BUDGET);
assert.equal(await allowR2Read(kv, {}, readDb), false, "read budget must be enforced");
readDb.fail = true;
assert.equal(await allowR2Read(kv, {}, readDb), false, "D1 read failure must fail closed");

assert.equal(await reserveR2Write(kv, "x", 10, {}, undefined), false, "missing D1 write must fail closed");
const writeDb = new MemoryBudgetDb();
assert.equal(await reserveR2Write(kv, "x", 10, {}, writeDb), true);
assert.equal(writeDb.values.get(`write:${month}`), 1);
assert.equal(writeDb.values.get("storage-reserved-bytes:v1"), 10);

const writeLimitDb = new MemoryBudgetDb();
writeLimitDb.values.set(`write:${month}`, R2_MONTHLY_WRITE_BUDGET);
assert.equal(await reserveR2Write(kv, "x", 10, {}, writeLimitDb), false, "write budget must be enforced");

const storageLimitDb = new MemoryBudgetDb();
storageLimitDb.values.set("storage-reserved-bytes:v1", R2_STORAGE_RESERVATION_BUDGET_BYTES - 1);
assert.equal(await reserveR2Write(kv, "x", 2, {}, storageLimitDb), false, "storage budget must be enforced");

assert.ok(PREWARM_LANDMARKS.length >= 288);
assert.equal(
  ACTIVE_PREWARM_LANDMARKS.length,
  PREWARM_LANDMARKS.filter((item) => item.category !== "mountain").length + 1,
);
assert.deepEqual(
  ACTIVE_PREWARM_LANDMARKS.filter((item) => item.category === "mountain").map((item) => item.name),
  ["富士山"],
);
assert.equal(
  ACTIVE_PREWARM_LANDMARKS.filter((item) => item.category !== "mountain").length,
  PREWARM_LANDMARKS.filter((item) => item.category !== "mountain").length,
  "every non-mountain landmark must remain in prewarm",
);

for (const configName of [
  "wrangler.jsonc",
  "wrangler.spot-search.jsonc",
  "wrangler.bearing-profile-download.jsonc",
  "wrangler.prewarm.jsonc",
]) {
  const source = await fs.readFile(path.resolve(configName), "utf8");
  assert.match(source, /"binding"\s*:\s*"NETWORK_CACHE"/, `${configName}: R2 binding must remain enabled`);
  assert.match(source, /"binding"\s*:\s*"R2_WRITE_BUDGET_DB"/, `${configName}: shared D1 guard must be bound`);
}

console.log("R2 free-tier policy: PASS");
console.log(`limits: ${R2_STORAGE_RESERVATION_BUDGET_BYTES} bytes, ${R2_MONTHLY_WRITE_BUDGET} writes/month, ${R2_MONTHLY_READ_BUDGET} reads/month`);
console.log(`prewarm: ${ACTIVE_PREWARM_LANDMARKS.length}/${PREWARM_LANDMARKS.length} landmarks (Mount Fuji + all non-mountain targets)`);
