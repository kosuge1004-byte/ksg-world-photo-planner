# Phase 3 実装記録（DEM・高精度補間）

## 実装内容

- 高精度（maximumDetail: "1m"）のみ制約付きBicubicを使用。
- 標準・5m・10mはBilinearを維持。
- タイル境界の4x4近傍を隣接DEMタイルから取得。
- 経度方向のタイル番号はWeb Mercator世界周回に合わせてwrap。
- 緯度方向の範囲外はNO_DATA扱い。
- 4x4内にnull / NaN / InfinityがあればBilinearへフォールバック。
- Bilinearの4隅も隣接タイルから取得し、端ピクセルの重複利用を廃止。
- Bilinearの一部が欠損する場合は最寄りの有効点へフォールバック。
- Bicubicの出力は中央2x2の最小・最大標高にクランプし、オーバーシュートを防止。
- 隣接タイルは既存のfetchDecodedTileとtileCacheを共有し、重複通信を抑制。

## 変更ファイル

- server/gsiElevation.ts
- server/constrainedBicubicInterpolation.ts
- tests/regression/constrained-bicubic-interpolation.test.mjs
- scripts/verify-phase3-dem-bicubic.mjs
- package.json

## 実行結果

成功:
- node scripts/verify-phase3-dem-bicubic.mjs
- node --experimental-strip-types tests/regression/constrained-bicubic-interpolation.test.mjs
- ZIP破損検査

未実施:
- tsc -b
- npm run build
- 全回帰テスト

理由:
- ZIP内に完全なnode_modulesがなく、現在のnpm取得環境では既報の依存復元問題があるため。
- 全回帰テストはtypescriptパッケージ未導入で停止。

## 残事項

- 実データを使ったタイル境界の統合テスト。
- LOS側でのBilinear/Bicubic安全側包絡線は、既存遮蔽判定への影響が大きいためPhase 5の統合監査で扱う。
