// 2026-09-30: 登録スポットの計算済み方位プロファイルを Cloudflare Pages の
// 静的ファイルとして配信するための配置スクリプト。
//
// - dist/ を dist-pages/ へ複製し、計算済みファイルは dist-pages/ にだけ置く。
//   dist/ はAndroid/iOSのアプリ本体へ同梱されるため、そこへ数百MBの
//   プロファイルを入れるとアプリが肥大化する。
// - 置くのはマニフェストに載り、識別子・ファイル名・バイト数・SHA-256が
//   すべて一致したファイルだけ（R2公開スクリプトと同じ検査）。
// - 登録スポット一覧と照合し、計算済みファイルが無い登録スポット（座標修正後の
//   作り直し漏れ・未作成）を一覧表示する。--strict ではそれを失敗扱いにする。
// - データ置き場（Eドライブ）が無い環境では、静的ファイルなしで dist-pages/ を
//   作る。その場合もアプリは /api/bearing-profile-batch（R2）へ戻るので動作する。
//
// 使い方:
//   tsx scripts/stage-precomputed-profiles-for-pages.mjs [--data-root <dir>] [--strict]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  PRECOMPUTED_BEARING_PROFILE_DIRECTORY,
  PRECOMPUTED_BEARING_PROFILE_FORMAT,
  precomputedBearingProfileIdentity,
} from "../server/precomputedBearingProfiles.ts";
import { PRECOMPUTED_BEARING_PROFILE_TARGETS } from "../src/data/precomputedBearingProfileTargets.ts";

const DEFAULT_DATA_ROOT = process.env.LOCAL_DEM_DATA_ROOT ||
  "E:\\AstroSight-GSI-data-20260926\\dem\\r2-ready";
const REGISTERED_MAX_DISTANCE_METERS = 10_000;
// Cloudflare Pages の静的ファイル上限（1ファイル25MiB・2万ファイル）より十分小さく。
const MAX_FILES = 250;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const strict = process.argv.includes("--strict");
const distDir = path.resolve(option("--dist", "dist"));
const outDir = path.resolve(option("--out", "dist-pages"));
const dataRoot = path.resolve(option("--data-root", DEFAULT_DATA_ROOT));
const profileRoot = path.join(dataRoot, PRECOMPUTED_BEARING_PROFILE_DIRECTORY);

assert.ok(existsSync(path.join(distDir, "index.html")), `${distDir} がありません。先に npm run build を実行してください`);
await rm(outDir, { recursive: true, force: true });
await cp(distDir, outDir, { recursive: true });

const manifestPath = path.join(profileRoot, "manifest.json");
if (!existsSync(manifestPath)) {
  const message = `計算済みファイルの置き場所が見つかりません（${manifestPath}）。静的配信なしで ${path.basename(outDir)}/ を作成しました。`;
  if (strict) throw new Error(message);
  console.warn(`[stage-precomputed] ${message}`);
  process.exit(0);
}

const manifest = JSON.parse((await readFile(manifestPath)).toString("utf8"));
assert.equal(manifest.schemaVersion, 1, "manifest schemaVersion");
assert.equal(manifest.format, PRECOMPUTED_BEARING_PROFILE_FORMAT, "manifest format");
const entries = Object.entries(manifest.entries ?? {});
assert.ok(entries.length > 0 && entries.length <= MAX_FILES, `profile count must be 1-${MAX_FILES}`);

const targetDirectory = path.join(outDir, PRECOMPUTED_BEARING_PROFILE_DIRECTORY);
await mkdir(targetDirectory, { recursive: true });
let totalBytes = 0;
const staged = new Set();
for (const [identity, entry] of entries) {
  assert.equal(identity, precomputedBearingProfileIdentity(entry), `${entry.name}: identity`);
  assert.equal(entry.file, `${sha256(Buffer.from(identity, "utf8"))}.json.gz`, `${entry.name}: identity file name`);
  const source = path.join(profileRoot, entry.file);
  const metadata = await stat(source);
  assert.ok(metadata.isFile() && metadata.size === entry.bytes, `${entry.name}: byte count`);
  assert.ok(metadata.size > 0 && metadata.size <= MAX_FILE_BYTES, `${entry.name}: profile size`);
  const bytes = await readFile(source);
  assert.equal(sha256(bytes), entry.sha256, `${entry.name}: checksum`);
  totalBytes += metadata.size;
  await cp(source, path.join(targetDirectory, entry.file));
  staged.add(identity);
}
assert.ok(totalBytes <= MAX_TOTAL_BYTES, `profile total ${totalBytes} exceeds ${MAX_TOTAL_BYTES}`);

// 登録スポットとの照合（座標修正後の作り直し漏れ・未作成を検出）。
const missing = PRECOMPUTED_BEARING_PROFILE_TARGETS.filter((target) => !staged.has(
  precomputedBearingProfileIdentity({
    latitude: target.latitude,
    longitude: target.longitude,
    maxDistanceMeters: REGISTERED_MAX_DISTANCE_METERS,
  })
));
console.log(JSON.stringify({
  staged: staged.size,
  bytes: totalBytes,
  mib: Number((totalBytes / 1024 / 1024).toFixed(2)),
  registeredTargets: PRECOMPUTED_BEARING_PROFILE_TARGETS.length,
  missingTargets: missing.length,
  output: path.relative(process.cwd(), targetDirectory),
}, null, 2));
if (missing.length > 0) {
  const names = missing.slice(0, 20).map((target) => target.name).join("、");
  const message = `計算済みファイルが無い登録スポットが${missing.length}件あります: ${names}${missing.length > 20 ? " ほか" : ""}`;
  if (strict) throw new Error(message);
  console.warn(`[stage-precomputed] ${message}（これらは /api/bearing-profile-batch → 1方位経路で取得されます）`);
}
