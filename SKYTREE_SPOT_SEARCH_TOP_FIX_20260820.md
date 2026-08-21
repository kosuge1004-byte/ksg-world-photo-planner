# スポット検索 高塔頂上ピン修正（2026-08-20）

## 原因
`src/cesium/plateauBuildingVerification.ts` の屋根/頂上候補検証で、DEM地表から120mを超えるPLATEAU表面を粗大異常として除外していた。このため東京スカイツリー（634m）や東京タワー（333m）などの正規の高塔頂上が候補から脱落し、スポット検索後の被写体ピンが頂上へ移動できなかった。

## 修正
- 旧 `GROSS_MISALIGNMENT_TOLERANCE_METERS = 120` を廃止。
- 検索座標から最大50m以内という既存の水平探索制約は維持。
- 構造物として妥当な高さ上限を `MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS = 1000` とし、0〜1000mの表面を候補として許容。
- `Number.isFinite` を追加し、NaN/Infinityを除外。
- 1000m超は高さ基準ずれ・破損タイル等の粗大異常として除外。

## 専用静的回帰検証
`scripts/verify-tall-structure-roof-resolution.mjs`

確認済み:
- 80m: PASS
- 東京タワー 333m: PASS
- 東京スカイツリー 634m: PASS
- -1m: reject PASS
- 1500m: reject PASS
- 旧120m制限が残っていないこと: PASS

## 未確認
プロジェクト全体の回帰テストは展開ZIPに `node_modules/typescript` が無いため起動不能。実機/Cesium+PLATEAUデータを用いたスカイツリー頂上の最終視覚確認は別途必要。
