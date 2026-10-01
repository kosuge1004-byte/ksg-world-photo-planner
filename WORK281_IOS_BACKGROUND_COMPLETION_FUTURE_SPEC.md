# WORK281: iOS背景実行対応・将来メモ（未実装・設計のみ）

Work280でAndroidのバックグラウンド完走まわりを修正した際に浮かび上がった、
iOS側の既知のギャップをまとめておく。**今回は一切実装しない。** 次にiOS対応
に着手するときの出発点として使うこと。この環境にはXcode/macOSがなく、以下
はどれもビルド・実機検証していない設計メモの段階。

## 現状（2026-09時点でのコード確認結果）

- `lib/features/common/raw_selection_screen.dart` の進捗画面分岐
  （`Platform.isAndroid && mode in {milkyWay, starTrail, meteor}` の分岐、
  現在おおよそ160行目付近）で、Android以外（＝iOS含む全て）は常に
  `ProcessingProgressScreen`（画面を開いている間だけ処理が進む、旧来の
  フォアグラウンド専用実装）に落ちる。
- `ios/Runner/Info.plist` に `UIBackgroundModes` の宣言なし。バックグラウンド
  実行の申請自体をしていない。
- `ios/Runner/AppDelegate.swift` にバックグラウンドタスク関連の実装なし。
- 画質計算のDartコード（`milky_way_pipeline.dart` の
  `registerAndCombineDecodedFrames`、`cfa_drizzle_milky_way_pipeline.dart`
  等）はプラットフォーム非依存の共通コードなので、Work280のタイル/フレーム
  cooldownの恩恵はiOSでも画面を開いている間は自動的に効く。iOS固有の対応が
  要るのは「バックグラウンドでも継続実行させる」部分だけ。

## Android版との仕組みの違い（重要）

AndroidのWorkManager（`FOREGROUND_SERVICE` + `foregroundServiceConfig`）を
iOSにそのまま移植することはできない。iOSのバックグラウンド実行モデルは別物。

| 項目 | Android（今回実装） | iOS（未実装・別方式が必要） |
|---|---|---|
| 継続実行の仕組み | WorkManager foreground worker | `BackgroundTasks`フレームワークの`BGProcessingTask` |
| 実行保証 | 権限が揃えば継続実行を試みる | OSが空き時間に「数分程度」だけ実行を許可。連続実行は保証されない |
| CPUスリープ対策 | `wakelock_plus`で明示的にウェイクロック取得 | 同等のAPIなし。BGProcessingTaskの許可時間内でしか動けない |
| 発熱状態の取得 | `PowerManager.currentThermalStatus`（Android提案・未実装） | `ProcessInfo.thermalState`（`nominal/fair/serious/critical`） |

## iOS側で必要になる作業（着手時のチェックリスト）

1. `ios/Runner/Info.plist` に以下を追加（Work280で一度仮追加して今回は
   revertした。実装するときに戻すこと）：
   - `UIBackgroundModes` に `processing`
   - `BGTaskSchedulerPermittedIdentifiers` に自前のタスク識別子
     （例: `com.mobilestack.app.stackProcessing`）
2. XcodeプロジェクトのSigning & Capabilitiesで「Background Modes」→
   「Background processing」を有効化（plistの宣言だけでは不十分、Xcode側
   の証明書・プロビジョニングにも紐づく）。
3. `AppDelegate.swift` で`BGTaskScheduler.shared.register(...)`を起動時に
   登録し、Dart側（Flutterの`MethodChannel`経由）から処理開始・状態照会
   できるブリッジを実装する。
4. Dart側に、`lib/core/background/background_task_dispatcher.dart`
   相当のiOS版エントリーポイントを作り、既存の`runStandardStackBackgroundTask`
   等（プラットフォーム非依存）をそのまま呼び出せるようにする。ロジックの
   再実装は不要、起動経路だけ足す。
5. `raw_selection_screen.dart`の分岐条件を、Android専用条件から
   `Platform.isAndroid || Platform.isIOS`（かつ対応モード）に広げ、iOS版の
   進捗画面（Android版`StandardBackgroundProgressScreen`のiOS版、または
   共通化）を作る。
6. BGProcessingTaskは実行時間が不確実なので、**「前回どこまで終わったか
   から再開できる」**ようにする必要が、Androidより強く出る（AndroidのWork274
   のリカバリー機構をより頑健にした形が必要）。
7. サーマル対応を入れるなら`ProcessInfo.thermalState`の監視を追加し、
   Work280で入れた固定cooldown（8ms/150ms）をAndroid・iOS共通で適応型に
   置き換える設計にする（これはAndroid側でも別途提案済みの改善）。

## ビルド・検証手段（Mac未所持のため）

手元のMacが古くXcode非対応と確認済み。Mac購入なしで進める場合は
Codemagic等のクラウドCI（Flutter公式サポートあり、無料枠あり）でiOSビルド
・署名・配布を行う想定。着手時に別途アカウント準備が必要。

## 今回スコープ外（Work280はAndroidのみ）

- `ios/Runner/Info.plist`の変更は一旦revert済み（未実装のまま宣言だけ残す
  とApp Store審査で説明を求められる可能性があるため）。
