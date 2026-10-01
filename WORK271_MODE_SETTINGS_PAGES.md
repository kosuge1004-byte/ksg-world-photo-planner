# Work271 — 4モード各種設定ページ統一

## 目的
Work270の天の川・星景スタックに追加した「基準写真選択後の各種設定」設計を、残る3モードにも適用する。

## 画面遷移
- 天の川・星景スタック: 撮影画像選択 → 基準写真選択 → 各種設定 → 処理開始
- 星の軌跡: 撮影画像選択 → 基準写真選択 → 各種設定 → 処理開始
- 流星群: 撮影画像選択 → 各種設定 → 流星候補解析 → 候補レビュー
  - 流星群パイプラインには基準写真選択工程が存在しないため、撮影画像選択の直後に配置。
- 深度合成: 撮影画像選択 → 基準写真選択 → 各種設定 → 合焦位置解析 → レビュー → 深度合成

## 各モードの表示内容
### 天の川・星景スタック
- 画質
- 出力方式
- ファイル容量
- 移動体（飛行機等）自動削除 ON/OFF

### 星の軌跡
- 画質
- 出力方式
- ファイル容量
- 合成方式: 比較明合成（固定）

### 流星群
- 画質: 最高画質（固定）
  - 現行パイプラインは流星検出を原寸RAWで行うため、効かない画質選択肢は表示しない。
- 出力方式
- ファイル容量
- 流星候補の選択: 自動検出・分類後、レビュー画面でユーザーが最終選択

### 深度合成
- 画質: 最高画質（固定）
  - 現行の高精度・原寸RAW処理を維持。
- 出力方式
- ファイル容量
- 省略可能な写真を表示
- 省略可能な写真を自動除外
  - これら2項目は従来の深度合成メイン画面から各種設定ページへ移動。

## 実処理への接続
- 天の川の移動体自動削除: Work270のON/OFFを通常パイプラインで表示するよう配線を修正。
  - CFA Drizzle実験経路では未対応なので表示しない。
- 星の軌跡: 既存の画質・出力方式・DNG圧縮（ファイル容量）を維持。
- 流星群: ファイル容量のDNG圧縮指定を MeteorReviewScreen → meteor_composite_result → exportTileStoreToImage まで追加接続。
- 深度合成: ファイル容量のDNG圧縮指定を FocusStackScreen → focus_stack_export → focus_stack_linear_dng_export → exportTileStoreToLinearDng まで追加接続。

## 変更ファイル（主要）
- lib/features/common/raw_selection_screen.dart
- lib/features/common/stack_settings_screen.dart
- lib/features/common/processing_progress_screen.dart
- lib/features/milkyway/cfa_drizzle_milky_way_screen.dart
- lib/features/meteor/meteor_review_screen.dart
- lib/core/meteor/meteor_composite_result.dart
- lib/features/focus_stack/focus_stack_screen.dart
- lib/features/focus_stack/focus_stack_settings_screen.dart (新規)
- lib/core/focus_stack/focus_stack_export.dart
- lib/core/focus_stack/focus_stack_linear_dng_export.dart
- test/mode_specific_settings_screen_test.dart (新規)

## 検証
この作業環境には Flutter/Dart SDK が存在しないため、flutter analyze / flutter test / APK build は未実行。
代替として以下を実施済み。
- 主要配線のソース検査: PASS
- 変更Dart 10ファイルの括弧/波括弧/角括弧の粗い整合検査: PASS
- ZIP整合性検査: 別途 zip -T で確認

Flutter環境では以下を必須実行すること。
1. flutter analyze
2. flutter test
3. Android debug/release build
4. 各4モードの実画面遷移確認
5. Linear DNGの「最大編集耐性」と「画質維持・容量節約」のファイルサイズ差確認（特に流星群・深度合成）
