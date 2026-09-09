# 三脚候補周辺データダウンロードのサーバー側バックグラウンドジョブ化 (2026-09-08)

## 背景

Web（および将来のAndroid/iOSネイティブアプリ）で「アプリ/タブを完全に
閉じても、ダウンロードと計算が完了している」ことを実現するには、
処理そのものをブラウザ/WebViewのJS実行に依存させない設計が必須。
ブラウザはタブ/アプリが閉じるとJS実行を完全に停止する仕様であり、
これは回避不能（Wake Lock APIは画面点灯維持のみ、Service Worker
Background SyncはChromium限定でiOS非対応、かつ完走の保証がない）。

既存の「スポット検索」機能が、まさにこの制約を回避するために
Cloudflare Queue + Workers KVでサーバー側バックグラウンドジョブとして
実装されていたため、同じ設計を三脚候補周辺データダウンロードにも適用した。

## 実コード変更

- `src/types/backgroundBearingProfile.ts`（新規）: ジョブ入出力の型。
- `server/bearingProfileDownloadJobs.ts`（新規）: KV永続化・入力検証。
  spotSearchJobs.tsと同じ設計（1箇所のset関数だけがkv.putを呼ぶ）。
- `server/runBearingProfileDownloadJob.ts`（新規）: 実際の360方位ぶんの
  地形取得（10m粗探索→1m高精度）・水面判定・OSM周辺情報取得。
  距離配列・密度規則は端末版のbackfillBearingProfilesと完全に同一
  （sampleServerWorldTerrain / calculateKarneyDestinationPointを共有）。
- `workers/bearing-profile-download-consumer.ts`（新規）: Queue Consumer。
- `functions/api/bearing-profile-download-start.ts` /
  `-status.ts`（新規）: ジョブ開始・進捗確認のPages Functions API。
- `functions/_shared/env.ts`: 新しいKV/Queueバインディングを追加
  （R2/D1と同じくoptional。未設定でもビルド・他機能に影響しない）。
- `wrangler.jsonc` / `wrangler.bearing-profile-download.jsonc`: 新規
  バインディング設定（実際に作成するまでコメントアウト。手順は
  README_BEARING_PROFILE_DOWNLOAD_JOB_SETUP.md参照）。
- `src/cache/tripodBearingProfileManager.ts`: `backfillBearingProfiles`を
  全面書き換え。端末側は「未取得の方位を判定→サーバーへジョブ開始/再接続
  →進捗ポーリング→完了データをIndexedDBへ書き込み」の3ステップのみ。
  DEMタイル参照カウント（recordGsiDeviceTileReferencesForPoints）は
  既存の共有タイル安全削除の仕組みと整合するよう維持。
- `src/search/backgroundSpotSearch.ts`: `deviceClientId()` / `newId()`を
  export化し、端末識別子をスポット検索ジョブと共有。
- `src/components/BearingProfileDownloadDialog.tsx`: サーバー側の進捗
  文言（`serverMessage`）を優先表示するよう更新。説明文もサーバー処理を
  反映して更新。

## 意図的にスコープ外とした点

DEM生タイル（標高ラスター画像そのもの）の事前オフラインキャッシュは
今回のジョブには含めていない。三脚候補の最終cm精度確認は読み出し時に
必ずライブで取り直す設計（`tryUseBearingProfileCache`）のため、
生タイルの事前キャッシュは正しさに影響しない速度最適化に過ぎず、
通常のライブ操作で自動的に埋まる。タイル参照カウント自体
（`recordGsiDeviceTileReferencesForPoints`、緯度経度のみで動作し
実際のタイル取得を伴わない）は維持し、共有タイル安全削除の整合性は
保っている。

## 更新した回帰テスト

以下は旧（端末が全処理を担う）アーキテクチャを前提にしていたため、
現行のサーバージョブ設計を検証するよう更新した（アルゴリズム・座標列・
DEM詳細度は一切変更していない）:

- `scripts/verify-bearing-profile-download-stall-fix-20260908.mjs`
- `scripts/verify-downloaded-data-audit-fixes-20260908.mjs`
- `scripts/verify-downloaded-site-context-cache-20260908.mjs`
- `scripts/verify-downloaded-spot-high-precision-20260908.mjs`
- `scripts/verify-cloudflare-migration.mjs`（KVバインディング1個前提を
  緩和し、新バインディングがコメントアウト方式でも通るよう調整）
- `scripts/verify-workers-kv-writes.mjs`（新ファイルをallowlistへ追加）

## 検証結果

- `npx tsc -b --noEmit`: PASS
- `npm run build`: PASS
- `verify-*.mjs` 全100本: 93 PASS / 7 FAIL（残り7件は全て既存の環境要因
  のみ。今回の変更由来の新規失敗なし）
- `npm run test:regression`（公式回帰スイート）: 48グループ全PASS
