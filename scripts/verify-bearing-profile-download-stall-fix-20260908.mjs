import fs from 'node:fs';

// 2026-09-08追記（サーバー側バックグラウンドジョブ化に伴う全面更新）:
// 元々このテストは「端末側の1方位ぶんの地形取得ステージに上限時間を設ける」
// ことで0°停止を防ぐ実装を検証していた。今回、実際の360方位ぶんの地形・
// 水面・OSM取得そのものをCloudflare Worker（Queue Consumer）側の
// バックグラウンドジョブへ全面移動したため、端末側にはもう「長時間ハング
// しうる個別の重い通信」自体が存在しない（開始→ポーリング→結果書き込み、
// の3ステップだけになった）。したがって0°停止という不具合クラスは
// アーキテクチャ上そもそも起こりえなくなった。このテストは新設計での
// スタール安全性（無限待機しない・アプリを閉じてもジョブを止めない・
// 再開時に同じジョブへ再接続する）を検証する。
const manager = fs.readFileSync('src/cache/tripodBearingProfileManager.ts', 'utf8');
const dialog = fs.readFileSync('src/components/BearingProfileDownloadDialog.tsx', 'utf8');
const jobRunner = fs.readFileSync('server/runBearingProfileDownloadJob.ts', 'utf8');
const consumer = fs.readFileSync('workers/bearing-profile-download-consumer.ts', 'utf8');

const checks = [
  // 端末側はもう360方位ぶんの地形取得を自前で行わない（サーバーへ委譲）。
  ['client no longer performs per-bearing terrain fetch loop itself',
    !manager.includes('sampleWorldTerrain(') && !manager.includes('sampleWorldTerrainNeutral(')],
  // ポーリングに待機上限（Workers KV反映待ちの猶予）があり、無限に待たない。
  ['missing-job polling has a bounded grace period',
    /MISSING_JOB_GRACE_MS\s*=\s*90_000/.test(manager) && manager.includes('elapsed < MISSING_JOB_GRACE_MS')],
  ['polling uses an abortable bounded delay, not a busy loop',
    manager.includes('abortableDelay(POLL_INTERVAL_MS, signal)')],
  // 端末側の中断（タブを閉じる等）はサーバー側ジョブを止めない
  // ＝ジョブ開始APIとは別にキャンセルAPIを呼んでいないことを確認する。
  ['client abort does not cancel the server-side job',
    manager.includes('サーバー側のジョブ自体は止めない') && !manager.includes('bearing-profile-download-cancel')],
  // アプリを閉じて再度開いても、同じ被写体・同じカメラ高であれば
  // 新規ジョブを起動せず、既存のactiveKeyへ再接続して進捗を引き継ぐ。
  ['reopening resumes the same job instead of restarting from zero',
    manager.includes('readActiveDownloadJobs()[activeKey]') && manager.includes('existingActive?.jobId ?? newId()')],
  // 実際の重い処理（地形・水面・OSM取得）がサーバー側で完結する。
  ['heavy work actually runs server-side in the queue consumer',
    consumer.includes('runBearingProfileDownloadJob') && jobRunner.includes('sampleServerWorldTerrain')],
  // サーバーは1方位失敗しても全体を止めず、必ず進捗を更新し続ける
  // （個々の失敗がプロセス全体をハングさせない設計は维持）。
  ['single bearing failure does not halt the whole job',
    /catch \(error\) \{\s*\/\/ 1方位の失敗で全体を止めない/.test(jobRunner)],
  ['dialog shows the live server progress message',
    dialog.includes('progress.serverMessage')],
];

let failures = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}
if (failures) process.exit(1);
