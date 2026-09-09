import fs from "node:fs";

// 2026-09-09追記: 実機での動作確認で発覚した不具合の再発防止テスト。
// 進捗率・進捗メッセージだけの更新（status/profiles/errorを含まない）を
// 一切KVへ書き込まない設計のままだと、UIが「○/○方位」という細かい
// 進捗を見せる作りである以上、端末には最初の1メッセージしか届かず、
// 実際には処理が進んでいても「固まって見える」不具合を引き起こす。
const jobs = fs.readFileSync("server/bearingProfileDownloadJobs.ts", "utf8");

const checks = [
  ["progress-only updates are eventually persisted (not silently dropped forever)",
    jobs.includes("dueForThrottledProgressPersist") &&
    jobs.includes("progressChanged && now - lastPersistedAtMs >= PROGRESS_PERSIST_INTERVAL_MS")],
  ["throttle interval is bounded (not zero, not absurdly long)",
    /PROGRESS_PERSIST_INTERVAL_MS\s*=\s*(\d+)_?(\d*)/.test(jobs) &&
    (() => {
      const match = jobs.match(/PROGRESS_PERSIST_INTERVAL_MS\s*=\s*([\d_]+)/);
      const ms = Number(match[1].replace(/_/g, ""));
      return ms > 0 && ms <= 15_000;
    })()],
  ["terminal states (complete/failed) still force a persist regardless of throttle",
    jobs.includes('update.status !== undefined || update.profiles !== undefined || update.error !== undefined')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
