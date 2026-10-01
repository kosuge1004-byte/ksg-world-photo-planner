# Work352: mediaProcessing 上限到達後に再開できない問題（型は mediaProcessing のまま）

## 原因
Android 15 の ActiveServices は、上限到達後の新しい mediaProcessing FGS を
`r.app.mState.getLastTopTime() > timeLimitExceededAt` のときだけ許可する（`r.app` はサービスを
ホストするプロセス）。ProcessorService は `:processor` で動き、このプロセスは Activity を持たないため
一度も TOP にならない。MainActivity（メインプロセス）を前面にしても条件を満たさず、実機で数時間
「Time limit already exhausted」のまま再開できなかった（再起動か24時間経過まで）。
MainActivity の既存コメント「Activity にフォーカスがあればリセット点がある」はこの点で誤り。

## 変更
| ファイル | 内容 |
|---|---|
| android/.../ProcessorForegroundResetActivity.kt | 新規。`:processor` で動く半透明・履歴なし Activity。表示後 400ms で自ら終了。サービスは起動しない |
| android/app/src/main/AndroidManifest.xml | 上記 Activity を `android:process=":processor"`、exported=false、excludeFromRecents、noHistory で宣言 |
| android/.../MainActivity.kt | 予算切れ（同期例外・ResultReceiver 経由の両方）で、フォーカスがある場合のみ上記 Activity を1回表示（1起動系列につき最大2回）。終了後にフォーカスが戻ると既存の onWindowFocusChanged の再試行が :processor で ProcessorService を起動する |
| android/.../ProcessorService.kt | 上限時メッセージを「アプリを開くと自動再開（できない場合は端末再起動または24時間後）」に（工程ラベルは不変） |
| tool/work352_processor_foreground_reset_contract.test.mjs | 静的契約4件 |

不変: ProcessorService の foregroundServiceType は mediaProcessing。SupervisorService 不変。既存契約（Work331/335 等）はすべて PASS。

## 検査
実施: Node 全テスト PASS。
未実施（要実機）: Android がどの時点で lastTopTime を記録するかはアプリから観測できないため、
実機（Android 15 / 16）で「上限到達 → アプリを開く → 再開」が成功するか確認が必要。
確認手順: `adb shell device_config put activity_manager media_processing_fgs_timeout_duration 60000`
で上限を1分にし、処理開始 → 上限到達 → アプリを開いて再開、を確認。logcat の
`Requested :processor foreground reset` と、その後の ProcessorService 起動成功を記録。
