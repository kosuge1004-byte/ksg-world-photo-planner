import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  PRECOMPUTED_BEARING_PROFILE_DIRECTORY,
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  PRECOMPUTED_BEARING_PROFILE_R2_PREFIX,
  precomputedBearingProfileIdentity,
} from "../server/precomputedBearingProfiles.ts";

const DEFAULT_DATA_ROOT = "E:\\AstroSight-GSI-data-20260926\\dem\\r2-ready";
const DEFAULT_BUCKET = "astrosight-network-cache";
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const execute = process.argv.includes("--execute");
const dataRoot = path.resolve(option("--data-root", DEFAULT_DATA_ROOT));
const bucket = option("--bucket", DEFAULT_BUCKET);
const profileRoot = path.join(dataRoot, PRECOMPUTED_BEARING_PROFILE_DIRECTORY);
const manifestPath = path.join(profileRoot, "manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

assert.equal(manifest.schemaVersion, 1, "manifest schemaVersion");
assert.equal(manifest.format, PRECOMPUTED_BEARING_PROFILE_FORMAT, "manifest format");
const entries = Object.entries(manifest.entries ?? {});
assert.ok(entries.length > 0 && entries.length <= MAX_FILES,
  `profile count must be 1-${MAX_FILES}`);

let totalBytes = 0;
for (const [identity, entry] of entries) {
  assert.equal(identity, precomputedBearingProfileIdentity(entry), `${entry.name}: identity`);
  assert.match(entry.file, /^[a-f0-9]{64}\.json\.gz$/, `${entry.name}: file name`);
  assert.equal(entry.file, `${sha256(Buffer.from(identity, "utf8"))}.json.gz`,
    `${entry.name}: identity file name`);
  const filePath = path.join(profileRoot, entry.file);
  const metadata = await stat(filePath);
  assert.ok(metadata.isFile(), `${entry.name}: profile is not a file`);
  assert.equal(metadata.size, entry.bytes, `${entry.name}: byte count`);
  assert.ok(metadata.size > 0 && metadata.size <= MAX_FILE_BYTES,
    `${entry.name}: profile size`);
  const bytes = await readFile(filePath);
  assert.equal(sha256(bytes), entry.sha256, `${entry.name}: checksum`);
  totalBytes += metadata.size;
}
assert.ok(totalBytes <= MAX_TOTAL_BYTES,
  `profile total ${totalBytes} exceeds ${MAX_TOTAL_BYTES}`);

console.log(JSON.stringify({
  mode: execute ? "execute" : "dry-run",
  bucket,
  prefix: PRECOMPUTED_BEARING_PROFILE_R2_PREFIX,
  files: entries.length,
  bytes: totalBytes,
  mib: Number((totalBytes / 1024 / 1024).toFixed(2)),
}, null, 2));

if (!execute) {
  console.log("検査のみ完了しました。アップロードは実行していません。実行時だけ --execute を付けます。");
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
for (const [index, [, entry]] of entries.entries()) {
  const source = path.join(profileRoot, entry.file);
  const objectPath = `${bucket}/${PRECOMPUTED_BEARING_PROFILE_R2_PREFIX}${entry.file}`;
  console.log(`[${index + 1}/${entries.length}] ${entry.name}`);
  const result = spawnSync(npx, [
    "wrangler", "r2", "object", "put", objectPath,
    "--file", source,
    "--content-type", "application/json",
    "--content-encoding", "gzip",
    "--remote",
    "--force",
  ], { stdio: "inherit", cwd: path.resolve(".") });
  if (result.status !== 0) {
    throw new Error(`${entry.name} のR2アップロードに失敗しました`);
  }
}
console.log(`${entries.length}件の計算済み地形データをR2へ公開しました。`);
