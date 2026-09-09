# AstroSight 直接ダウンロード不具合 修正まとめ — 2026-09-09

## 修正対象

1. 実使用中の `backfillBearingProfiles()` が360方位を完全直列処理していた。
2. 1方位の10m/1m DEM段階が各45秒まで待つため、異常時に約90秒以上/方位になり得た。
3. `gsiElevationClient` が最大10 HTTP並列、Worker内部が最大12タイル並列で、多重並列による滞留を起こし得た。
4. 「端末直接方式ならCloudflare制限を受けない」という設計コメントが実経路と不一致だった。DEMは現在も `/api/gsi-elevation` (Pages Function) を通る。
5. DEM取得失敗が続いても360方位を延々と試行する経路があった。
6. 0件/一部失敗でもストレージ書込失敗が0なら `status: complete` になり得た。
7. 高精度DEM失敗時にWorld Terrainへフォールバックした値を高精度ダウンロード成功として扱い得た。
8. ダウンロード開始前に `enableBearingProfile()` していたため、初回失敗でも有効状態だけ残り得た。
9. `scripts/run-regression-tests.mjs` に文字列形式・`script:`形式のケースがあり、実際にはテストを実行しないまま通過する項目があった。
10. 2026-09-09追加の並列/タイムアウト/進捗テストは未使用サーバージョブだけを見ており、実使用の直接経路を保証していなかった。

## 実装した修正

- 直接ダウンロードを `BEARING_CONCURRENCY = 2` の限定ワーカープールへ変更。
- DEM APIのグローバルHTTP上限を10→6へ変更。
- Worker内部GSIタイル取得上限を12→6へ変更。
- `/api/gsi-elevation` 1要求タイムアウトを30秒→12秒へ変更。
- 方位ごとの10m/1m地形段階上限を45秒→20秒へ変更。
- 初期6方位が全失敗ならシステム障害として早期中止。
- 結果に requested/successful/failed/aborted の方位数を追加。
- 一部失敗、abort、ストレージ書込失敗では `complete` を登録しない。
- 1m要求が `CESIUM_WORLD_TERRAIN` へフォールバックした方位は高精度取得成功と数えない。
- `enableBearingProfile()` は完全成功確認後にのみ初回有効化。
- 回帰テストランナーを正規化し、引数なしテストを黙ってPASSさせない。
- 実使用直接経路専用 `verify-bearing-profile-direct-download-20260909.mjs` を追加し、回帰ランナーへ登録。
- 既存の9/9サーバージョブ3テストも回帰ランナーへ明示登録（未使用経路であることを名称に明示）。

## 精度維持

以下は変更していない。

- 方位1°刻み（360方位）
- 距離サンプリング生成ロジック
- 1m/5m/10m DEM詳細度指定
- GSI DEM1A/5A/5B/5C/10Bの優先順位
- Constrained Bicubic / Bilinear補間
- Karney測地線による地点生成
- ジオイド・楕円体高の計算経路

速度改善は処理順序、並列上限、異常待機時間、完了判定だけで行った。

## 検査結果

PASS:

- `verify-bearing-profile-direct-download-20260909.mjs` 11/11
- `verify-bearing-profile-download-stall-fix-20260908.mjs` 8/8
- `verify-bearing-profile-job-concurrency-20260909.mjs` 7/7
- `verify-bearing-profile-job-timeout-safety-20260909.mjs` 9/9
- `verify-bearing-profile-progress-visibility-20260909.mjs` 3/3
- `verify-downloaded-data-audit-fixes-20260908.mjs` 12/12
- `verify-river-point-geoid-final-20260908.mjs` 4/4
- `verify-downloaded-data-management-detail-20260908.mjs` 16/16
- 回帰ランナー先頭から water-surface-zero まで、修正後に実際に各テストが実行されPASS。
- 変更したTS/TSX 4ファイルをTypeScript 5.8.3 `transpileModule` で構文検査し全PASS。

未完了の検査:

- 完全な `npm run build` / TypeScript型解決を伴う全回帰試験は、この実行環境で `npm ci` がタイムアウトし依存パッケージを取得できなかったため未実施。
- 回帰ランナーは `production calculation regression` まで進み、コード失敗ではなく `node_modules/typescript` 不在で停止した。

## 実機で確認すべき点

- 0/360から最初の進捗までの秒数
- 10m→1mの各段階が通常数秒以内で進むこと
- 2方位並列により進捗が継続して増えること
- 通信障害時に長時間360方位を回さず早期エラーになること
- 一部取得失敗時に「保存しました」と表示されないこと
