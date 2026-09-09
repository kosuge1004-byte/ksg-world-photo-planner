import fs from "node:fs";

// 2026-09-09追記: 実機での動作確認で「サーバー側の外部API呼び出しに
// タイムアウトが無く、ジョブ全体が永遠にハングしうる」不具合が見つかった
// ため修正した。さらに、単純に「タイムアウトしたら次へ進む」だけでは、
// システム的な障害（GSI API全断など）で全方位が延々と失敗し続けた末に
// 「空のデータで完了しました」という嘘の成功報告を出しかねない、という
// 指摘を受けて、連続失敗の早期中止・ゼロ件完了の禁止も追加した。
const job = fs.readFileSync("server/runBearingProfileDownloadJob.ts", "utf8");

const checks = [
  ["external calls have a bounded timeout helper", /EXTERNAL_CALL_TIMEOUT_MS\s*=\s*45_000/.test(job) && job.includes("async function withTimeout")],
  ["10m coarse terrain fetch is timeout-protected", /withTimeout\(\s*sampleServerWorldTerrain\([\s\S]{0,200}"10m"/.test(job)],
  ["1m high precision terrain fetch is timeout-protected", /withTimeout\(\s*sampleServerWorldTerrain\([\s\S]{0,200}"1m"/.test(job)],
  ["water/river site-context fetch is timeout-protected", /withTimeout\(\s*fetchServerSiteContexts\(waterPrefetchPoints/.test(job)],
  ["subject-surroundings site-context fetch is timeout-protected", /withTimeout\(\s*fetchServerSiteContexts\(fullSiteContextPoints/.test(job)],
  // 「タイムアウトして次に進むだけでは駄目」への対応:
  ["systemic failure (all early attempts fail) triggers an early, honest abort (not silent grinding)",
    /FAILURE_ABORT_THRESHOLD\s*=\s*8/.test(job) && job.includes("successCount === 0 && failureCount >= FAILURE_ABORT_THRESHOLD")],
  ["early abort marks the job failed with a clear error, not complete",
    /if \(abortReason\) \{[\s\S]{0,150}status: "failed"/.test(job)],
  ["zero successful bearings never gets reported as a successful completion",
    /if \(profiles\.length === 0\) \{[\s\S]{0,200}status: "failed"/.test(job)],
  ["a single isolated failure among otherwise-successful bearings still does not halt the whole job",
    job.includes("successCount += 1") && job.includes("failureCount += 1") && !job.includes("MAX_CONSECUTIVE_FAILURES")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
