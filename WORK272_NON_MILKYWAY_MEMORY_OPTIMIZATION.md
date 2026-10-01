# Work272 — 天の川以外3モードの最高画質維持・メモリ軽量化

基準: Work271

## 対象
- 星の軌跡
- 流星群
- 深度合成

天の川スタックの処理コードは変更していない。

## 1. 流星群
`lib/core/session/meteor_pipeline.dart`

従来は解析済み全フレームのフル解像度 `LuminancePlane` (Green) を
`greenPlaneByFrameIndex` に保持していた。

Work272ではこの全保持を廃止。一次解析では検出結果・星座標だけを保持し、
Brightness Profile が必要になった候補フレームだけを二次パスで1枚ずつ再読込する。
候補順序・検出アルゴリズム・閾値・Brightness Profile計算式は変更しない。

効果: Green面のRAM使用量がフレーム枚数に比例して増える構造を除去。
代償: 候補があるフレームのみファイルバックRGBの再読込I/Oが発生。
画質/判定ロジック: 変更なし。

## 2. 星の軌跡
`lib/core/stacking/tiled_lighten_blend_combiner.dart`

従来は各バンドについて全フレームの `CoveredLinearRgbTile` をListへ保持後に合成。
Work272では1フレームずつ読み込み、逐次的に結果へ反映する。

- keepHighest=1: running max
- keepHighest>1: per-sample bounded top-K
- coverage / minimumCoveringFrames の意味は従来と同一

メモリ量は「フレーム数 × バンド」から「1フレーム × バンド + Top-K」へ。
比較明の演算意味は変更しない。

`test/tiled_lighten_blend_combiner_test.dart` に、旧 `lightenBlendCombineCoveredRgb`
と逐次実装を keepHighest=1/2/3 で直接比較する回帰テストを追加。

## 3. 深度合成
`lib/core/focus_stack/focus_stack_pipeline.dart`

従来は基準フレームのフル解像度Greenを保持したまま、各フレームの
Aligned Green + coverage を作成してFocus Measureを計算していた。

Work272では2段階化:
1. 基準Greenを保持して全フレームのCorrespondence/Transformだけ決定。
2. 基準Greenを解放。
3. 各フレームのAligned Green + coverageを1枚ずつ生成しFocus Measureへ。

Bicubic補間、Correspondence計算、Modified Laplacian、最終Blendは変更しない。
ピーク時からフル解像度Float32 Green 1面分を外すことが目的。

## 検証制約
この環境には Flutter / Dart SDK がないため、`flutter test`, `flutter analyze`,
APKビルドは未実行。ソース差分・静的配線・ZIP整合性を検査する。
