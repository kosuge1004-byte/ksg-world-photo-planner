# AstroSight 全体監査まとめ 2026-09-08

## 今回の実コード修正
- 三脚候補のECEF再収束ループ終了後に、最終候補地点そのものを観測点として気象を再解決し、天体見かけ高度と被写体見かけ高度、方位残差を再計算する最終収束ゲートを追加。
- 最大3反復終了、または局所地形再探索が空でbreakしただけの未収束候補を確定しない。
- 最終判定条件は既存 `CONVERGED_HORIZONTAL_DEGREES` を高度・方位の双方に使用。
- 地点別気象は既存0.05度セルPromiseキャッシュを使用し、同一セルの重複I/Oを増やさない。
- 廃止済みCameraModelを前提にしたジオイドコメントを現行実装へ整理。

## 回帰テスト更新
- `verify-tripod-candidate-weather-reconvergence.mjs` を現行の候補セル気象 + 最終収束ゲートへ更新。
- `verify-tripod-adaptive-intersections.mjs` を現行30m coarse densification / batched multi-intersection / 1m final refinementへ更新。

## 実行結果
- verify scripts: 98本中67 PASS / 31 FAIL。
- `npx tsc --noEmit`: PASS。
- 新しい候補地点気象/最終収束検査: PASS。
- adaptive intersection: PASS。
- tripod timeout elimination: 15/15 PASS。
- water/river: 12/12 PASS。

## 残る31 FAILの扱い
現時点で、今回確認した範囲では新たな実コード精度回帰とは確定していない。主な内訳:
- 依存/実行環境: TypeScript/Vite/GeographicLib不足、Nodeの.ts直接import、Android同期済みweb assets不在。
- 旧仕様文字列テスト: centerline/apparent-preview/CameraModel round-trip、通常タップ被写体ピン、三脚手動offset、Cesium default render loop、terrain normals常時ON、Cesium Usage旧文言。
- ジオイド/camera-height系: 現行コードでは地点別N、H=h-N、h=H+N、候補地点withLensCenterHeightが存在するが旧テストが旧変数名/旧構造を要求。

## 判定
全体監査は大幅に整理できたが、31 FAILをすべてPASSへ書き換えること自体を目的にはしない。古いテストを現仕様へ更新する場合も、仕様変更の証拠がある項目だけを更新する。
