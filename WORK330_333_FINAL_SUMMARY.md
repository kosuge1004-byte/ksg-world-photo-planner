# Work330〜333 総合サマリー
## MobileStack — Android FGS起動レジリエンス + 完走可能性の監査・修正

## 全体の経緯
「星の軌跡」処理中に発生した実機エラー
`PlatformException(processor_start_failed, startForegroundService() not
allowed: service com.mobilestack.app/.SupervisorService, ...)` の調査から
始まり、「絶対大丈夫と言えるレベルまで」という要求のもと4段階の深掘り
監査を行い、都度見つかった問題を修正した。

## 発見・修正した問題（時系列）

### Work330（前提として検証済み・当セッション外）
Supervisor（補助プロセス）のFGS起動拒否が、成功していたはずのProcessor
（本体処理）の起動まで「失敗」として握りつぶしてしまう問題。Processor
優先起動・Supervisorのbest-effort化で解消。

### Work331 — 2つの追加の穴
1. **Processor自身のFGS拒否への耐性欠如**：自動復帰時、Processor自身の
   起動がFGS拒否された場合の再試行ロジックが無かった。Supervisorと同じ
   リトライ（500ms後 + フォーカス復帰時、最大6回）を追加。
2. **自動復帰失敗の誤エラー表示**：`standard_background_progress_screen.dart`
   だけ、自動復帰の失敗を`_error`として表示し、再試行不能な行き止まり
   画面になっていた。他画面と同じ「握りつぶして次の機会に再試行」に統一。
3. （調査追加分）**同時呼び出しでの`Result`上書き**：自動復帰と手動ボタンが
   同時に走ると、先に保留していた呼び出しの`Result`が上書きされ永久に
   完了しなくなる問題。`waiters`リストで複数呼び出し元を合流させる設計に
   変更。

### Work332 — ジョブ同一性の欠落
Work331の「合流」ロジックがjobIdを確認せずに合流させていたため、
別々のジョブが誤って同じ結果を共有してしまう可能性があった。
`pendingProcessorLaunches`を`jobId`キーのMapに変更し、ジョブ単位で
完全に独立させた。

### Work333 — 「完走できない可能性」の広域監査
1. **running固着**：`processorUnresponsive`からの手動再起動が最終的に
   失敗すると、ステータスが`running`のまま誰にも修復されず、新規ジョブ
   開始もブロックされる詰み状態になっていた。再起動失敗時に
   `interruptedRecoverable`へ自動的にダウングレードする自己修復ロジックを
   追加（新しい`recoveryCause`: `processor-restart-fgs-denied`）。
2. **天の川画面の`_error`固着バグ**：ジョブが実際に回復してもUIの`_error`
   が二度と消えず、バックグラウンドで完走していても画面は「失敗」表示の
   まま、という独立したバグを修正。
3. **天の川画面に再起動導線が皆無だった**：標準画面と同等の「保存済み
   地点から再開」「処理システムだけ再起動して続行」ボタンを追加。
4. （調査追加分）**判定条件の重複**：`home_screen.dart`が`recoveryCause`
   を独自にハードコードしており、Work333で追加した新原因を見逃していた。
   共有の`ForegroundTimeoutRecovery.recoverableCauses`を参照するよう統一。

## 検証の到達点
- **Kotlin**：この環境にAndroid SDKは無いが、GitHub releasesから実際の
  Kotlin 1.9.24コンパイラを取得し、使用されているAndroid/Flutter/org.json
  APIを手作業で再現したスタブと共に`MainActivity.kt`・`ProcessorService.kt`
  ・`SupervisorService.kt`（3ファイルとも現状の実ファイル）を実際にコンパイル。
  **エラー0件**。警告は自作スタブ側のみで、実ファイル側の警告は既存コード
  （今回変更していない箇所）の軽微な未使用引数1件のみ。
- **Dart**：Dart/Flutter SDKがネットワーク制限で入手不能なため、変更した
  4ファイルすべてを一行ずつ手動精読し、型・null安全性・存在しない
  メンバー参照が無いことを確認。
- **テスト**：`tool/run_all_node_tests.sh` — **725/725 PASS**
  （既存の契約テスト2ファイルをリファクタに合わせて更新、新規契約
  テストを4ファイル追加）。

## 変更ファイル一覧（累積）
```
android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt
lib/core/background/foreground_timeout_recovery.dart
lib/features/home/home_screen.dart
lib/features/common/standard_background_progress_screen.dart
lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart
tool/android_fgs_timeout_recovery_contract.test.mjs        (更新)
tool/work330_supervisor_fgs_start_resilience_contract.test.mjs  (更新)
tool/work331_processor_own_fgs_start_resilience_contract.test.mjs  (新規)
tool/work332_processor_launch_job_identity_contract.test.mjs      (新規)
tool/work333_stuck_job_self_healing_contract.test.mjs             (新規)
WORK331_PROCESSOR_OWN_FGS_START_RESILIENCE.md
WORK332_PROCESSOR_LAUNCH_JOB_IDENTITY.md
WORK333_STUCK_JOB_SELF_HEALING.md
WORK330_333_FINAL_SUMMARY.md（本ファイル）
```

## 変更していないもの
- RAWデコード・検出・スタッキング・画質・チェックポイントロジック全般
- Supervisorが非FGS理由で起動失敗した場合に一切リトライしないという
  設計判断（Work330由来、今回のスコープ外）
- iOS側のコード（今回の問題はAndroid FGS制限に固有）

## 残る限界（正直な申告）
- 実機・Androidエミュレータでのビルド・動作確認は本環境では実施不可能
- 「Supervisor起動失敗＋Processorハング」のような低頻度の複合シナリオは
  実機での意図的な再現が難しく、ロジックレビューが中心
- Dartは実コンパイラ検証ではなく手動精読どまり
