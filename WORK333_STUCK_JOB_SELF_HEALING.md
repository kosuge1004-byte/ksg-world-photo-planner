# Work333 — 「running固着」ジョブの自己修復化 + 天の川画面のパリティ修正

## 経緯
「完走できない可能性」を広い視点で再監査し、Work330〜332とは別系統の
2つの問題を発見した。

1. `standard_background_progress_screen.dart`の`processorUnresponsive`
   （`running`のまま15秒以上更新なし）から「処理システムだけ再起動して
   続行」ボタンを押した際、その再起動が最終的に失敗すると、ステータス
   ファイルは`running`のまま誰にも修正されず固着する。`interruptedRecoverable`
   と異なり、`ForegroundTimeoutRecovery`はこの状態を拾わず、
   `StackJobRegistry.activeJob()`は`running`を「アクティブ」とみなして
   新規ジョブの開始もブロックする。ユーザーは同じボタンを押し続ける
   以外に手段がなくなる。
2. `cfa_drizzle_milky_way_progress_screen.dart`（天の川）には、
   ①`running`固着に対する手動再起動ボタン自体が存在せず、
   ②`interruptedRecoverable`/`failed`で一度`_error`が立つと、その後
   ジョブが自動復帰などで実際に回復しても**`_error`が二度と`null`に
   戻らず**、画面が永久に「スタック処理に失敗しました」を表示し続ける
   という、独立したバグがあった。

## 変更

### 1. `MainActivity.kt` — 再起動失敗時のステータス自己修復
- `ProcessorLaunchWaiter`に`isRestart: Boolean`を追加し、新規ジョブの
  初回起動（`restart=false`）と、既存ジョブの再起動（`restart=true`）を
  区別できるようにした。
- `attemptProcessorLaunch()`の最終失敗分岐（リトライ使い切り、または
  FGS起因以外のエラー）で、`isRestart`なwaiterが1つでもあれば
  `markJobRecoverableAfterProcessorLaunchFailure()`を呼び、ステータス
  ファイルの`state`が`queued`/`running`のままなら`interruptedRecoverable`
  に書き換える（すでに終端状態や`interruptedRecoverable`であれば触らない）。
- 新しい`recoveryCause`として`"processor-restart-fgs-denied"`
  （`RECOVERY_CAUSE_PROCESSOR_RESTART_DENIED`定数）を導入。元の
  `"foreground-service-timeout"`（Work328由来）とは原因が異なるため、
  混同を避けて別の値にした。
- `onDestroy()`でも、破棄時になお保留中の`isRestart`なwaiterがあれば
  同じ補正を適用する。
- 新規ジョブの初回起動失敗（`restart=false`）はこの補正の対象外のまま
  （Dart側の`BackgroundStackController._registerUniqueTaskVerified`が
  既にレジストリを片付ける設計のため、"ダウングレード"すべき既存
  ステータスがそもそも存在しない）。

### 2. `foreground_timeout_recovery.dart` — 復帰対象の原因を拡張
- `recoveryCause != 'foreground-service-timeout'`という単一文字列比較を、
  `_recoverableCauses`（`{'foreground-service-timeout',
  'processor-restart-fgs-denied'}`）という集合による判定に変更。
  これにより、Work333で新設した原因のジョブも既存の自動復帰パイプライン
  にそのまま乗る。

### 3. `cfa_drizzle_milky_way_progress_screen.dart` — 標準画面とのパリティ
- `_restartingProcessor`/`_autoResumingTimeout`フィールドと
  `_restartProcessor()`メソッドを追加（`standard_background_progress_screen.dart`
  と同型）。Android専用。
- `_resumeAfterPlatformTimeoutThenPoll()`に多重発火防止のガードを追加。
- `_processorUnresponsive`ゲッターを追加し、`_buildProgress()`に
  「処理システムだけ再起動して続行」カードを追加。
- `_buildError()`に、`_status?.state == StackJobState.interruptedRecoverable`
  のときだけ表示される「保存済み地点から再開」ボタンを追加。
- **`_error`が固着するバグを修正**：`_pollStatus()`で、ステータスが
  `queued`/`running`（＝健全な稼働中）に戻ったことを検知したら
  `_error`を`null`に戻すようにした。これが無いと、ジョブが実際には
  バックグラウンドで正常に完走していても、画面は「失敗」表示のまま
  固まる。

## 変更していないもの
- RAWデコード・検出・スタッキング・画質・チェックポイントロジック。
- Work330〜332で確立した起動順序・リトライ・ジョブ同一性の仕組み。
- 手動再起動が本当に何度やっても成功しない場合の最終的なエラー表示
  自体（それは正しい挙動として維持）。

## 検証
- `tool/android_fgs_timeout_recovery_contract.test.mjs`（Work328由来の
  既存テスト）：`recoveryCause`の単一文字列比較チェックを、新しい
  集合ベースの判定に対応する形に更新。PASS。
- `tool/work331_...test.mjs`：`isRestart`導入と`markJobRecoverableAfter...`
  呼び出しの挿入に合わせて、失敗分岐・`onDestroy`のアサーションの
  文字数バジェットを調整。PASS。
- 新規`tool/work333_stuck_job_self_healing_contract.test.mjs`：
  - `isRestart`フィールドの存在と新規/再起動それぞれでの設定値
  - 終端失敗時・`onDestroy`時いずれも、`isRestart`なwaiterがある場合に
    ステータス補正が呼ばれること
  - 補正が`queued`/`running`のときだけ発火し、`interruptedRecoverable`
    に書き換え、専用の`recoveryCause`を使うこと
  - `ForegroundTimeoutRecovery`が新旧両方の原因を受け付けること
  - 天の川画面に`_restartingProcessor`/`_autoResumingTimeout`/
    `_restartProcessor`/`_processorUnresponsive`/両ボタンが揃っている
    こと
  - 天の川画面の自動復帰`catch`が`_error`を立てないこと
  - `_error`固着バグの修正（健全状態復帰時に`_error`をクリアすること）
  を検証。PASS。
- `bash tool/run_all_node_tests.sh`：**725/725 PASS**（Work332時点の724
  から新規テスト1件増加、既存テストは1件（レガシーアサーション）を
  新設計に合わせて更新した上で全件PASS）。

## 未実施
この環境にはAndroid SDK/Gradle/Flutter SDKが無いため、Kotlinコンパイル・
`dart analyze`・`flutter test`・実機/エミュレータでの動作確認は未実施。
特に「Supervisorが非FGS理由で起動失敗した後、Processorが本当にハング
する」という組み合わせ自体は実機でも狙って再現しにくいシナリオであり、
本監査はコードレビューによるロジック検証が中心である点に留意されたい。
また、Supervisorが非FGS理由で起動失敗した場合に一切リトライしない
という設計判断そのもの（Work330由来）は今回のスコープ外として変更して
いない。
