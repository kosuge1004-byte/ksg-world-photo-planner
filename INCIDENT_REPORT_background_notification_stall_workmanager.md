# インシデント報告：他アプリへ切替時に進捗通知が更新されなくなる（星の軌跡ほか全モード共通）

**対象アプリ**: MobileStack（Android, Flutter）
**報告日**: 2026-09-13
**調査者**: Claude（ユーザー提供の診断ログ1件の解析のみ。実機アクセスなし）
**結論の確信度**: 高い（ログの症状・タイミング・コード構造が完全に一致）

---

## 1. 症状

星の軌跡モードで処理中、他アプリに切り替えると通知が更新されなくなり、
処理が止まっているように見える。ただし実際のフレーム処理（RAWデコード等）
自体は裏で継続している。

## 2. 証拠となったログ

ユーザー提供の診断ログに、以下が高頻度（同一秒内に十数回）で連続記録:

```
background progress update failed or timed out: TimeoutException after 0:00:10.000000: Future not completed
```

フレーム1のdecode完了直後から発生し、フレーム2のdecode完了後にも同様に
発生。つまり**アプリ切替の有無に関係なく、進捗更新のたびに毎回10秒待たされて
タイムアウトしている**。

## 3. 根本原因

`lib/core/background/stack_job_reporter.dart` の `_publishSnapshot()` が、
無条件に以下を呼んでいた:

```dart
await Workmanager().reportProgress(snapshot.toMap());
```

このアプリのAndroid実装は、`background_stack_controller.dart` の
`_registerUniqueTaskVerified()` のコメントにある通り、**WorkManagerを
使わない設計に移行済み**:

```dart
// Android heavy processing is intentionally *not* hosted by the
// WorkManager FlutterEngine.  ProcessorService is manifest-isolated
// into the :processor OS process, ...
await RemoteProcessorBridge.start(...);
```

実際のジョブは `ProcessorService`（別OSプロセス `:processor`、
`processor_runtime.dart` の `processorMain()` エントリポイント）で走る。
この `processorMain()` は **`Workmanager().initialize()` を一度も呼ばない**
（ドキュメントコメントにも明記: 「deliberately separate from `main` and
WorkManager's headless callback」）。

つまり `stack_job_reporter.dart` の `Workmanager().reportProgress()` 呼び出しは、
WorkManagerがAndroidの実行経路として使われなくなった後も削除されずに
残っていた**旧アーキテクチャ（Work274時代）の残骸**であり、呼び出す先の
実行コンテキストが存在しない。この呼び出しはFutureが永遠に完了せず、
`_runBestEffort()` の10秒タイムアウトで毎回強制的に打ち切られていた。

### なぜ通知が更新されなくなるか

`_publishSnapshot()` の中で、この呼び出しは
`StackJobNotifications.showRunning()`（実際の進捗通知を書き換える処理）
より**前**に置かれている:

```dart
await Workmanager().reportProgress(snapshot.toMap());  // ← ここで毎回10秒ハング
...
await StackJobNotifications.showRunning(...);           // ← 到達できない
```

さらに publish は `_publishInFlight` フラグで直列化されているため、
1回のハングが「進捗通知が二度と更新されない」状態を作っていた。
ステータスファイル自体（アプリ内の進捗バー用）は `writeAtomically()` が
このハングより前に完了しているため書き込まれており、それが「アプリ内では
進捗が見えるのに通知だけ更新されない／裏で動いていないように見える」
という体感の差につながっていたと考えられる。

## 4. 実施した修正

`stack_job_reporter.dart` の該当呼び出しを、Android以外のプラットフォーム
のみに限定し、念のため2秒のタイムアウトも追加:

```dart
if (!Platform.isAndroid) {
  try {
    await Workmanager()
        .reportProgress(snapshot.toMap())
        .timeout(const Duration(seconds: 2));
  } on Object {
    // Keep processing; the persisted heartbeat remains authoritative.
  }
}
```

これにより、Androidでは `StackJobNotifications.showRunning()` に即座に
到達できるようになり、進捗通知が本来の頻度（最短1秒間隔、実プラットフォーム
送信は最短5秒間隔）で更新されるはず。

## 5. 未検証・次の確認事項

- Flutter/Dart SDKがこの調査環境に無いため、`flutter analyze` / 実機ビルド
  / 実機での長時間試験は未実施。次の環境で必ず通すこと。
- 同じ `Workmanager().reportProgress()` を経由していた他のバックグラウンド
  ワーカー（天の川・流星・フォーカススタック等、すべて同じ
  `StackJobReporter` を共有）も同時に恩恵を受けるはずだが、各モードでの
  実機再検証を推奨。
- 「他アプリへ切替時」という報告があった一方、ログ上はアプリ切替とは
  無関係に毎回発生していた。ユーザーが気づいたのが切替後だっただけの
  可能性が高いが、切替そのものに起因する別の問題（例: OEM省電力機能）が
  重畳していないかは、この修正の効果を実機確認したうえで再評価すること。
- `INCIDENT_REPORT_processor_restart_crash.md`（前回のクラッシュ調査）は
  別件（再開ボタンでのクラッシュ）であり、本件とは無関係と考えられるが、
  両方とも `stack_job_reporter.dart` 周辺の実行時挙動に触れるため、
  次の調査者は双方のレポートを参照されたい。

## 6. 追記（2026-09-13）: 「保存済み地点から再開」に容量チェックが無かった件

ユーザーから「スタート前の容量計算の確認が無くなってる」との報告があり
調査した結果、**新規ジョブ開始時**の容量チェック
（`_preflightStandardStackStorage`、`_startStandardStackInternal`から
2回呼ばれる）自体は正しく残っていた。

一方、**中断済みジョブを「保存済み地点から再開」ボタンで再開する経路**
（`BackgroundStackController.restartProcessor`）は、新規開始時のこの
チェックを一度も呼ばずに直接`RemoteProcessorBridge.restart(...)`を
呼んでいた。つまり空き容量が不足したまま端末を放置して「再開」を押すと、
容量不足のまま処理システムが再起動され、ワーカー側のランタイムガード
（`standard_stack_background_worker.dart`の`_StorageCapacityException`、
書き込み失敗時に事後的に検出）に頼るしかない状態だった。ユーザーが
報告した症状（以前はエラーで止まっていたのに今はそのまま始まってしまう）
と一致する。

`restartProcessor`に、永続化済みのジョブpayload(`work_input.json`)から
`sourcePaths`/`darkFramePaths`/`flatFramePaths`/`referenceIndex`/`mode`/
`automaticMovingObjectRemoval`を読み出し、`standardStack`ジョブに限り
再起動前に同じ`_preflightStandardStackStorage`を呼ぶよう修正した
(`background_stack_controller.dart`)。

**既知の制約（未検証）**:
- `cfaDrizzle`・`focusStack`・`focusMarking`・`meteorAnalysis`・
  `meteorComposite`の再開経路は今回対象外（`_preflightStandardStackStorage`
  自体が天の川／星の軌跡専用の見積もりロジックのため）。同様の抜けが
  無いか、これらも別途確認が必要。
- 再開時点で`sourcePaths`が指すのは新規開始時に既にステージング済みの
  コピーであり、その分のバイト数は実際には既に消費済みのディスク容量で
  ある。`_preflightStandardStackStorage`はそれも「必要容量」に含めて
  見積もるため、再開時はやや厳しめ（安全側）の判定になる。実機での
  誤検知（本来再開できるのに容量不足と判定される）が無いか確認が必要。
- Flutter/Dart SDKがこの環境に無いため、`flutter analyze`・実機検証とも
  未実施。
