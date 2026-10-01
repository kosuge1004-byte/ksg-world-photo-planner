# Work273 — 星の軌跡 飛行機・人工衛星自動除去

## 目的
Work272を基準に、星の軌跡モードへ飛行機・人工衛星の光跡を保守的に自動除外するON/OFF設定を追加する。天の川スタックは変更しない。

## 実装
- `ProcessingSession`へ`automaticStarTrailAircraftRemoval`を追加。初期値ON。
- `AppSettings`へ`automatic_star_trail_aircraft_removal_v1`を追加し永続化。
- 星の軌跡「各種設定」に`飛行機・人工衛星自動除去`スイッチを追加。
- ON時、比較明合成前に既存の流星解析器`analyzeDecodedFrames`を再利用して光跡候補を解析。
- 自動除外条件:
  1. `StreakPersistenceCategory.independentMotion` — 星野の推定移動と一致しない継続光跡。
  2. `StreakBrightnessProfile.likelyBlinking` — 複数の明部/暗部を持つ航空機点滅パターン。
  3. ただし`StreakPersistenceCategory.skyMotion`は常に保持する。
- 除外は画素を黒塗り・生成補完せず、対象フレームの該当光跡周辺だけcoverage=0として比較明合成候補から外し、他フレームの実画素を採用する。
- coverageマスクはタイル/バンド領域だけ生成し、フルフレームマスクを保持しない。
- OFF時はWork272までの通常比較明合成経路をそのまま使用する。

## 保守的判定の意図
単一フレームに連続線としてだけ写った光跡は、流星等との完全自動識別に十分な画像情報がないため、`independentMotion`または点滅根拠が得られない限り自動除外しない。誤除去による星軌跡欠損を避けるため。

## 既知の原理的制約
飛行機/人工衛星の光跡と恒星軌跡が同じ画素で完全に重なった部分では、その1フレームの観測値から両者の光量を完全分離することはできない。本実装は対象フレームをその領域だけ除外して他フレームの実画素を使うため、交差位置で非常に短い星軌跡欠損が生じる可能性がある。生成補完は行っていない。

## 変更ファイル
- `lib/core/session/processing_session.dart`
- `lib/core/settings/app_settings.dart`
- `lib/features/common/raw_selection_screen.dart`
- `lib/features/common/stack_settings_screen.dart`
- `lib/features/common/processing_progress_screen.dart`
- `lib/core/session/export_pipeline_result.dart`
- `lib/core/session/star_trail_pipeline.dart`
- `test/mode_specific_settings_screen_test.dart`
- `test/star_trail_pipeline_test.dart`
- `pubspec.yaml` (`0.8.9+164`)

## 検証
この環境にはFlutter/Dart SDKがないため`flutter test`、`flutter analyze`、APKビルドは未実行。
実施済み:
- 変更Dartファイルの括弧/波括弧/角括弧静的整合チェック: PASS
- ON/OFF UI・永続キー・処理フラグ・解析呼出・`skyMotion`保護・点滅判定・coverage除外のソース配線チェック: PASS
- `lib/features/milkyway/`のWork272との差分: なし
- `lib/core/session/milky_way_pipeline.dart`のWork272との差分: なし
- 回帰テスト追加: 星の軌跡設定表示、および除外光跡領域で他フレームの実画素が採用されること。
