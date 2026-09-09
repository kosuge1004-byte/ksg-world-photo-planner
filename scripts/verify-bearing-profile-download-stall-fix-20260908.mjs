import fs from 'node:fs';

// 2026-09-09追記（サーバー側ジョブ化を試みた後、直接方式へ差し戻した経緯）:
// 2026-09-08にこの不具合を直すため、まずクライアント側に1段階(10m/1m取得)
// あたりのタイムアウトを追加した。その後、同じ処理をサーバー側で実行する
// 設計に変更したが、Cloudflare Workers無料プランのsubrequest上限
// （50回/呼び出し）に抵触したため、実用に耐えなかった。「他アプリに
// 切り替えている間だけ続けば十分」という実際の要件に立ち返り、
// クライアント直接方式へ差し戻した（ブラウザにはCloudflareの
// 方位ループ自体は端末で行うがDEM取得はPages Functionを通るため、Worker側の上限も考慮する）。
// このテストは、差し戻し後も0°停止バグの修正（1段階ごとのタイムアウト）が
// きちんと残っていることを検証する。
const manager = fs.readFileSync('src/cache/tripodBearingProfileManager.ts', 'utf8');
const dialog = fs.readFileSync('src/components/BearingProfileDownloadDialog.tsx', 'utf8');

const checks = [
  ['per-stage hard timeout exists and is no longer the 45s stall window', /BEARING_TERRAIN_STAGE_TIMEOUT_MS\s*=\s*20_000/.test(manager)],
  ['whole terrain stage is Promise.race bounded', manager.includes('Promise.race([operation(controller.signal), timeoutPromise])')],
  ['parent abort propagates', manager.includes('parentSignal?.addEventListener("abort", onAbort, { once: true })')],
  ['10m profile uses bounded stage', /runBearingTerrainStage\(\s*\(stageSignal\) => sampleWorldTerrain\(/.test(manager)],
  ['1m high precision uses bounded stage', /runBearingTerrainStage\(\s*\(stageSignal\) => sampleWorldTerrainNeutral\(/.test(manager)],
  ['progress distinguishes profile stage', manager.includes('terrainStage: "profile"')],
  ['progress distinguishes high precision stage', manager.includes('terrainStage: "high-precision"')],
  ['dialog exposes current terrain substage', dialog.includes('terrainStage === "high-precision"')],
];

let failures = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}
if (failures) process.exit(1);
