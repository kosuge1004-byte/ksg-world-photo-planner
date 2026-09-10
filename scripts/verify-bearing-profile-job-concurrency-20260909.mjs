import fs from "node:fs";

// 2026-09-09追記: 「データ量だけで見れば数秒で終わるはず」という指摘を
// 受けて判明した不具合の修正を検証する。従来は360方位を1つずつ完全に
// 直列処理していたため、1方位あたり数秒でも合計で数分〜十数分かかって
// いた。各方位は互いに独立しているため、GSI側のグローバル同時実行数
// 制限（src/cesium/gsiElevationClient.tsのsharedQueue、現在6並列）に守られた
// 範囲で複数方位を並行処理するよう修正した。
const job = fs.readFileSync("server/runBearingProfileDownloadJob.ts", "utf8");

const checks = [
  ["bearings are processed with a concurrency pool, not one at a time",
    /BEARING_CONCURRENCY\s*=\s*(\d+)/.test(job) && Number(job.match(/BEARING_CONCURRENCY\s*=\s*(\d+)/)[1]) > 1],
  ["worker pool uses a shared, dynamically-advancing cursor (work-stealing), not fixed per-worker ranges",
    job.includes("let nextIndex = 0") && job.includes("nextIndex += 1")],
  ["all workers are actually launched concurrently via Promise.all", job.includes("await Promise.all(")],
  ["concurrency is capped by pendingBearings.length for small jobs (no idle workers)",
    job.includes("Math.min(BEARING_CONCURRENCY, pendingBearings.length)")],
  ["progress is reported per completed bearing regardless of concurrent completion order",
    job.includes("completedCount += 1") && /progress: `地形プロファイルを取得しています（\$\{completedCount\}/.test(job)],
  ["background concurrency is conservative and aligned with the direct path",
    /BEARING_CONCURRENCY\s*=\s*2/.test(job)],
  ["initial failures do not abort remaining bearings",
    !job.includes("FAILURE_ABORT_THRESHOLD") && !job.includes("abortReason")],
  ["all-failed jobs still cannot report false completion",
    job.includes("if (profiles.length === 0)") && job.includes('status: "failed"')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
