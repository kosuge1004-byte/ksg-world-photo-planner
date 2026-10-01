# Work334 — 再起動時の固定待ちを「死亡確認」に置き換え

## 経緯
実機で「保存済み地点から再開」を押すたびに、Androidの
「アプリが繰り返し停止しています」ダイアログが100%再現した。

調査の結果：
- `DiagnosticLog`（Dart側の診断ログ）に新しい記録が一切増えない
  →`processorMain()`にすら到達していない
- `ProcessorService.startFlutterRuntime()`の`try/catch`が書き込む
  `writeBootstrapFailure()`（`state: "failed"`）もUIに一度も現れない
  →Kotlinの例外処理層より手前で落ちている

これらから、クラッシュはKotlin/Dartの例外処理では捕まえられない層
（ネイティブのFlutterエンジン起動、またはRAWデコーダー等のネイティブ
ライブラリ）で起きていると強く推測されるが、logcat等が無いこの環境
では最終的な証明はできない。

一方で、`MainActivity.kt`の再起動処理には以前から次のような設計上の
弱点があった：

```kotlin
android.os.Process.killProcess(it)
...
mainHandler.postDelayed({
    requestProcessorLaunch(...)   // 750ms後、無条件に次を起動
}, 750L)
```

「殺したことを一切確認せず、決め打ちの750msだけ待って次を起動する」
という設計は、原因がこれで確定するかどうかに関わらず、それ自体が
脆弱である。特に今回は「6時間動き続けた後の強制終了」という、通常
より後始末が重くなり得るタイミングだった。

## 変更（`MainActivity.kt`）
`postDelayed(750L)`による固定待ちを廃止し、
`ActivityManager.runningAppProcesses`で`:processor`が実際にリストから
消えたことを確認してから再起動する方式に変更した。

- `awaitProcessorDeathThenLaunch()`：100ms間隔でポーリングし、
  `:processor`エントリが消えたら250msの猶予（設定`PROCESSOR_DEATH_SETTLE_MS`）
  を置いてから起動。
- 全体のタイムアウトは5秒（`PROCESSOR_DEATH_MAX_WAIT_MS`）。プロセス一覧
  の取得が信頼できない端末や、何らかの理由で消えたと確認できない場合
  でも、5秒でタイムアウトして起動を試みる（永久に固まらない）。
- 通常ケース（プロセスがすぐ消える）では、以前の750ms固定より**むしろ
  速く**（ポーリング検知＋250ms猶予）再起動できる。
- プロセスの後始末が重い端末では、以前の750msでは足りなかった分だけ
  長く（最大5秒まで）待てるようになる。

## 変更していないもの
- Processor優先起動・Supervisor補助起動という順序（Work330）
- FGS拒否時のリトライ・ジョブ単位の合流ロジック（Work331〜332）
- チェックポイント/ジャーナル/自己修復ロジック（Work333）

## 検証
- 新規`tool/work334_processor_death_confirmation_contract.test.mjs`：
  - `killProcess`後に固定`postDelayed`で即`requestProcessorLaunch`を
    呼ぶパターンが存在しないこと（退行防止）
  - `awaitProcessorDeathThenLaunch`が`runningAppProcesses`を実際に
    確認していること
  - ポーリング間隔・猶予・タイムアウトがすべて定数化され、無限に
    ポーリングし続けない設計になっていること
  - タイムアウト到達時も最終的に起動を試みる（永久ハングしない）こと
  を検証。PASS。
- `bash tool/run_all_node_tests.sh`：**726/726 PASS**（Work333時点の725
  から新規テスト1件増加、既存テストに退行なし）。
- GitHub releasesから取得した実Kotlinコンパイラ（1.9.24、手作業スタブ
  併用）で`MainActivity.kt`・`ProcessorService.kt`・`SupervisorService.kt`
  を再コンパイルし、**エラー0件**を確認（新規追加した
  `android.os.SystemClock`スタブを含む）。

## 正直な限界
これは**確度の高い推測に基づく改善**であり、「これで100%直る」という
証明はできていない。真の原因がKotlin/Dartより下のネイティブ層にある
以上、この環境（logcat・実機無し）で最終確認する手段が無い。ただし
「プロセスの死亡を確認せず固定時間だけ待つ」という設計は、この仮説の
正否に関わらずそれ自体が改善に値するため、実装した。実機での再現
テストが依然として必要。
