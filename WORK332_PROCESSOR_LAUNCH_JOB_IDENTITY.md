# Work332 — 保留中Processor起動のジョブ同一性確認漏れを修正

## 経緯
Work331で導入した「同一ジョブへの複数呼び出しを合流させる」仕組み
（`pendingProcessorLaunch`を単一の`ProcessorLaunchState`として保持し、
2つ目以降の呼び出し元は`waiters`として合流する設計）に、ジョブの
同一性チェックが抜けていた。

`StackJobRegistry.activeJob()`は`interruptedRecoverable`状態のジョブを
「アクティブ」とみなさない。そのため、あるジョブA（例：星の軌跡）が
FGS拒否で自動復帰のリトライ待機中（`pendingProcessorLaunch`にAがある状態）
であっても、ユーザーは全く別の新規ジョブB（例：天の川）を問題なく開始
できてしまう。Work331時点の実装は、保留中のリクエストがあれば**jobIdを
一切確認せずに**新しい呼び出しを合流させていたため、Bの呼び出しがAの
保留状態に紛れ込み、Aの`ProcessorService`起動が成功した瞬間にBの呼び出し
元にも`result.success(null)`が返っていた。しかし実際に起動した
`ProcessorService`のIntentの中身（taskName/payloadPath/statusPath/jobId）
はすべてAのものであり、**Bは実際には一度も処理が開始されないまま
「成功」と報告される**という、UI表示にとどまらない実処理上の誤りだった。

## 変更（`MainActivity.kt`）
- `pendingProcessorLaunch: ProcessorLaunchState?`（単一スロット）を
  `pendingProcessorLaunches: MutableMap<String, ProcessorLaunchState>`
  （**jobIdをキーにしたマップ**）に変更。
- `requestProcessorLaunch()`は`pendingProcessorLaunches[supervisorRequest.jobId]`
  を見て、**同じjobIdの保留があるときだけ**合流させる。異なるjobIdの
  リクエストは常に独立した新しい`ProcessorLaunchState`を持つ。
- `attemptProcessorLaunch()`の成功/失敗どちらの分岐でも、
  `pendingProcessorLaunches.remove(jobId)`と**自分のjobIdだけ**を対象に
  クリアする。
- リトライ管理（`attempt`カウンタ・`retryScheduled`フラグ）を、
  これまでの単一グローバル変数から`ProcessorLaunchState`インスタンス
  ごとのフィールドに移動。これにより、複数のジョブが同時に保留状態に
  なっても、それぞれ独立したリトライタイマーを持てるようになった
  （以前は単一の`processorRetryScheduled`フラグを共有していたため、
  理論上2つ目のジョブのリトライが正しくスケジュールされない懸念が
  あった）。
- `onWindowFocusChanged`は`retryAllPendingProcessorLaunchesIfForeground()`
  を呼び、マップ内の**全ての**保留中ジョブに対して即座にリトライを試みる。
- `onDestroy()`は、マップに残っている**全ジョブの**waitersに対して
  `result.error(...)`を呼んでから`pendingProcessorLaunches.clear()`する。

## 変更していないもの
- RAWデコード・検出・スタッキング・画質・チェックポイントロジック。
- Work330/Work331で確立したProcessor優先・Supervisor補助という起動順序、
  および「同一ジョブの複数呼び出しは合流させる」という基本方針そのもの
  （今回はその「同一ジョブ」の判定条件を追加しただけ）。
- Supervisor側の`pendingSupervisorStart`は単一スロットのまま
  （`MethodChannel.Result`を持たないfire-and-forgetのため、複数ジョブが
  重なった場合も「古い方の監視が失われる」だけで、Result未完了のような
  実害はないため、今回はスコープ外とした）。

## 検証
- `tool/work331_processor_own_fgs_start_resilience_contract.test.mjs`：
  マップ構造への変更に合わせてフィールド名・関数シグネチャのアサーション
  を更新。PASS。
- 新規`tool/work332_processor_launch_job_identity_contract.test.mjs`：
  - 保留状態がjobIdキーのマップであること
  - `requestProcessorLaunch`が新規リクエストの`jobId`で既存状態を検索
    すること（無条件の単一スロット参照ではないこと）
  - 成功・失敗どちらの分岐も自分のjobIdだけを対象にマップから除去する
    こと
  - `retryProcessorLaunchIfForeground`が「自分がまだ登録されている状態
    かどうか」をjobId経由で確認してから動くこと
  - `retryAllPendingProcessorLaunchesIfForeground`がマップ内の全エントリ
    をリトライすること
  - `attempt`/`retryScheduled`が状態ごと（グローバル共有ではない）で
    あること
  を検証。PASS。
- `bash tool/run_all_node_tests.sh`：**724/724 PASS**（Work331時点の723
  から新規テスト1件増加、既存テストに退行なし）。

## 未実施
この環境にはAndroid SDK/Gradle/Flutter SDKが無いため、Kotlinコンパイル・
`dart analyze`・`flutter test`・実機/エミュレータでの動作確認は未実施。
括弧・カッコの対応など簡易的な構文チェックのみ実施した。特に「2つの
異なるジョブが同時にFGS拒否でリトライ待機する」という状況そのものは
発生頻度が低いため、実機での意図的な再現確認が難しい。コードレビュー
（本監査）によるロジック検証が中心となっている点に留意されたい。
