# AstroSight 直接ダウンロード単一高精度パス化 2026-09-09

## 目的
直接ダウンロードの処理時間を、精度を落とさず短縮する。

## コード確認で確定した冗長処理
`src/cache/tripodBearingProfileManager.ts` は各方位について同じ地形点群を
1. `sampleWorldTerrain(..., "10m")`
2. `sampleWorldTerrainNeutral(..., "1m")`
の順に2回取得していた。

しかし保存する `BearingProfileEntry.points[].ellipsoidalHeightMeters` は、正常完了時には `precise[i].height`（1m優先側）だけを使用していた。
さらに1m側で Cesium World Terrain へフォールバックした方位は未完了として破棄されるため、正常保存時に10m結果が使われる経路は無かった。

## 修正
- ダウンロード専用経路から先行10m DEM取得を削除。
- 最初から `sampleWorldTerrainNeutral(..., "1m")` のみ実行。
- 保存値も `precise[i]?.height ?? 0` とし、使われない `coarse` 変数を削除。
- 20秒の段階タイムアウト、2方位限定並列、Cloudflare/GSI側の並列上限、失敗時早期中止、部分完了拒否は維持。
- DEMソース優先順位、Constrained Bicubic、測地点数、距離間隔、方位1度刻み、Karney測地線、ジオイド処理は変更していない。

## raw DEMタイル全域一括ダウンロードを採用しなかった理由
方位プロファイルは最大約640点×360方位をカバーする。1m/5m/10mのraw DEMタイルを対象範囲全域で端末へ一括保存すると、最終プロファイル容量より大幅に大きくなり、地点によって数十〜数百MB以上へ増える可能性がある。速度改善目的で容量を大幅増加させる変更は行わなかった。

既存の端末DEMタイルキャッシュと、ダウンロード済みデータ完全性判定（live DEM tileが存在すること）は維持している。

## 検査
PASS:
- `scripts/verify-bearing-profile-direct-download-20260909.mjs` 13/13
- `scripts/verify-bearing-profile-download-stall-fix-20260908.mjs` 7/7
- `scripts/verify-downloaded-spot-high-precision-20260908.mjs` 7/7
- `scripts/verify-downloaded-data-audit-fixes-20260908.mjs` 12/12
- `scripts/verify-downloaded-data-management-detail-20260908.mjs` 16/16
- サーバー側保持経路の9/9関連テストもPASS

この環境には `node_modules/typescript` が無いため、完全な `tsc` / `npm run build` は今回も未実行。依存不要の構造回帰テストは上記の通りPASS。

## 性能上の意味
従来は成功方位ごとに `10m + 1m` の2回のDEM取得を必ず行っていた。修正後は `1m優先` 1回のみ。
したがってDEM API本処理量は、成功経路では概ね半分になる。
実時間はR2ヒット率、GSI応答、対象地点のDEM1A/5m被覆に依存するため固定秒数は保証しない。
