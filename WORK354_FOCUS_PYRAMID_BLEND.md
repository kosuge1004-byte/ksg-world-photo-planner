# Work354: 深度合成 ピラミッド（多重解像度）合成（既定OFF）

## 目的
既存の深度マップ合成は画素ごとに写真を切り替える（高信頼度は単独、低信頼度は隣接写真と混合）。
写真間の明るさ差やボケ量の違いが、勝者マップの境界に継ぎ目・段差として出る。

## 方法
Burt–Adelson の多重解像度合成。既存の画素ごとの重み（FocusBlendWeightComputer の出力をそのまま使用）を
ガウシアンピラミッドで縮小し、各写真のラプラシアン帯域と帯域ごとに重み付け合成して再構成する。
細かい帯域は従来どおり鋭く切り替わり、低い帯域（明るさのうねり）だけが広くなじむ。

タイル分割は厳密: 5タップ二項カーネルは有限台なので、各画素は半径 4·2^L 以内の入力にしか依存しない。
各コアタイル（256px）を、原点を 2^L の倍数に揃え（全タイルで間引き格子を共有）、マージン136px（L=5 の依存半径128超）
で拡張した領域で処理する。Node 参照で、全画像一括処理とタイル処理の結果が完全一致することを確認（マージン不足の60pxでは不一致）。

各写真が覆っていない画素（ピント移動による倍率変化の端）は、深度マップ結果で埋めてからピラミッドを作る
（ゼロの縁が低帯域に混入しないように）。出力の被覆は深度マップ合成と同一。帯域再構成で強いエッジ横に生じうる
わずかな負値は0に丸める。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/focus_stack/focus_pyramid_blend.dart | 新規（ピラミッド合成、タイル領域、依存半径） |
| lib/core/focus_stack/focus_tiled_blender.dart | FocusBlendMethod{depthMap(既定), pyramid}、ピラミッド時のタイル処理（コア256px）、チェックポイントに方法を束縛（ピラミッド時のみ） |
| lib/core/focus_stack/focus_stack_pipeline.dart / focus_stack_background_worker.dart / background_stack_controller.dart | blendMethod の受け渡し（payload `focusBlendMethod`、無ければ depthMap） |
| lib/core/settings/app_settings.dart / lib/features/focus_stack/focus_stack_settings_screen.dart | 設定「境界をなめらかに合成（ピラミッド合成）」 |
| tool/raw_samples/focus_pyramid_blend_reference.mjs ほか | Node 参照・テスト5件、契約4件 |
| test/focus_pyramid_blend_test.dart | Dart テスト（一致・タイル完全一致・段差の平滑化・格子整列） |

## 性能・メモリ（未計測の見積もり）
拡張領域は約560²px（コアの約4.8倍の面積）。1タイルで全写真の拡張領域を保持する（写真30枚で約110MB）。
計算量はコア面積あたり既存より大幅に増える（帯域分解・再構成×3チャンネル×写真数、拡張領域分）。
24MP・30枚で数分〜十数分の増加を見込む。実機で計測のうえ、必要ならコアタイルを大きくする（メモリと引き換え）。

## 検査
実施: Node 全テスト PASS（827）。
未実施: flutter analyze / flutter test、実機の処理時間とメモリ、実RAWでの画質比較（虫の毛・細枝・前後の重なり部分でのハロの有無を要確認）。
