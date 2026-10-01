# Work331 — Processor自身のFGS拒否耐性 + 自動復帰の誤エラー表示修正
# （+ 追加監査で発見した同時呼び出し衝突の修正）

## 経緯
Work330のレビュー監査で見つかった2つの穴（Processor自身のFGS拒否に対する
耐性の欠如、`standard_background_progress_screen.dart`の自動復帰失敗が
`_error`を立てて行き止まり画面になる問題）をまず修正した。

その後の追加監査で、その修正自体が持ち込んだ**3つ目の穴**が見つかった：
`pendingProcessorLaunch`が単一スロットだったため、①自動復帰
（`ForegroundTimeoutRecovery.resumeIfNeeded()`）がFGS拒否でリトライ待機中
に、②同じ画面でユーザーが「保存済み地点から再開」ボタンを手動で押すと、
2つ目の呼び出しが1つ目の保留状態を上書きし、**1つ目の`MethodChannel.Result`
が二度と完了しない**（Dart側の`await`が永久にハングする）可能性があった。
この3つをまとめて修正する。

## 変更

### 1. `MainActivity.kt` — Processor自身のFGS拒否耐性
- `launchProcessor()`ラムダを廃止し、Supervisorと同じ「500ms後 + ウィンドウ
  フォーカス復帰時」の再試行を、最大`MAX_PROCESSOR_FGS_RETRIES`（6回、
  最大約3秒）までProcessor自身にも適用。

### 2. `standard_background_progress_screen.dart` — 自動復帰失敗の誤エラー表示解消
- `_resumeAfterPlatformTimeoutIfNeeded()`の`catch`から`_error`のセットを
  削除し、他の2箇所の監視者（`app.dart`／
  `cfa_drizzle_milky_way_progress_screen.dart`）と同じ「握りつぶして次の
  機会に再試行」という挙動に統一。

### 3. `MainActivity.kt` — 同時呼び出しの衝突（今回追加）
- `ProcessorLaunchRequest`（単一`Result`保持）を`ProcessorLaunchState`
  （`waiters: MutableList<ProcessorLaunchWaiter>`を保持）に置き換え。
- `requestProcessorLaunch()`が新設され、既に同じジョブのリトライが保留中
  なら、新しい呼び出し元は**既存の保留状態に`waiter`として合流**する
  （新しい競合する試行を開始して古い状態を上書きすることはない）。
- 実際の起動試行は`attemptProcessorLaunch()`が担い、成功時は
  `state.waiters`**全員**に`result.success(null)`を返し、最終的な失敗時も
  **全員**に`result.error(...)`を返す（それぞれ自分自身の`errorCode`/
  `defaultErrorMessage`で）。
- `onDestroy()`は、破棄時になお保留中の`waiters`が残っていれば、
  `Result`を明示的に`error(...)`で完了させてから状態をクリアする
  （以前は`null`を代入するだけで`Result`を放置していた）。

### 4. `standard_background_progress_screen.dart` — ボタン側のガード（今回追加）
- `_restartProcessor()`の早期returnガードに`_autoResumingTimeout`を追加。
- 「保存済み地点から再開」「処理システムだけ再起動して続行」両ボタンの
  `onPressed`条件にも`_autoResumingTimeout`を追加し、自動復帰処理が
  進行中はボタン自体を非活性にする。
- ネイティブ側が既に同時呼び出しを正しく合流させるようになったため、
  これは「そもそも重複呼び出しを起こさない」ための多層防御であり、
  必須ではないが、無駄な2回目のMethodChannel呼び出しを避けられる。

## 変更していないもの
- RAWデコード・検出・スタッキング・画質・チェックポイントロジック。
- Work330で確立したProcessor優先・Supervisor補助という起動順序。
- 手動の「処理システムだけ再起動して続行」ボタンが失敗した場合に`_error`
  を表示する挙動（自動復帰中でなければ）は維持。

## 検証
- `tool/work330_supervisor_fgs_start_resilience_contract.test.mjs`：
  リネームされた`requestProcessorLaunch`/`attemptProcessorLaunch`に合わせて
  更新。PASS。
- `tool/work331_processor_own_fgs_start_resilience_contract.test.mjs`：
  Processor自身のFGS拒否リトライ、`onDestroy`でのwaiter完了、
  複数waiterの合流（`requestProcessorLaunch`が既存状態に合流すること、
  成功時・失敗時とも全waiterに通知されること）、Dart側の自動復帰
  `catch`が`_error`を立てないこと、手動ボタンが自動復帰中は無効化される
  ことを検証。PASS。
- `bash tool/run_all_node_tests.sh`：723/723 PASS（退行なし）。

## 未実施
この環境にはAndroid SDK/Gradle/Flutter SDKが無いため、Kotlinコンパイル・
`dart analyze`・`flutter test`・実機/エミュレータでの動作確認は未実施。
括弧・カッコの対応など簡易的な構文チェックのみ実施した。実機ビルド環境で
の最終確認が必要。
