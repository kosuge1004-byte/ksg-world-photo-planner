# インシデント報告：「保存済み地点から再開」で繰り返しクラッシュ

**対象アプリ**: MobileStack（Android, Flutter）
**報告日**: 2026-09-12
**調査者**: Claude（このリポジトリのコード読解のみ。実機・logcat・ネイティブ
デバッガへのアクセスなし）
**目的**: 他のAI/エンジニアが引き継いで調査・検証できるよう、これまでの
事実・証拠・推論・既に潰した仮説・未解決点を1ファイルにまとめる。

---

## 1. 症状（ユーザー報告・実機スクリーンショットより）

- ジョブ：星の軌跡（standardStack, `ProcessingMode.starTrail`）、336枚中
  131枚まで処理済み、`ProcessingQualityLevel.maximum`
- Androidのフォアグラウンドサービス実行時間上限（約6時間）に到達し、
  ジョブは`StackJobState.interruptedRecoverable`（中断・再開可能）状態で
  停止
- 進捗画面に表示されている「稼働状態」欄に**「過去のprocessor終了履歴：
  CRASH」**という表示あり（アプリ内の履歴表示機能によるもの）
- 画面の「保存済み地点から再開」ボタンを押すと、**毎回100%再現**で
  Android標準の**「『Mobile Stack』が繰り返し停止しています」**という
  クラッシュダイアログが表示される
- 「アプリを閉じる」→ 再度アプリを起動 → 同じ画面（131/336、
  interruptedRecoverable）が表示される → 再度ボタンを押す → **同じ
  クラッシュダイアログが再現**（アプリの完全な再起動でも直らない）

## 2. 決定的な証拠（ログ突き合わせ）

ユーザーから、アプリの「設定→診断ログをコピー」で取得したログを
**3回**（別々のタイミングで）提供してもらったが、**3回とも一字一句
完全に同一のログ内容**だった：

```
=== 2026-09-12T10:45:04.705617 run start: standardStack mode=ProcessingMode.starTrail frames=336 quality=ProcessingQualityLevel.maximum ===
...
（フレーム108〜118までの正常な処理ログ。11:18:47付近で途切れている）
```

このログは336枚ジョブが**まだ正常に動いていた時点**（フレーム108〜118、
中断より前）のものであり、**クラッシュの瞬間を一切含んでいない**。

### この事実から言えること（推論であり、証明ではない）

このアプリの`DiagnosticLog`クラス（`lib/core/diagnostics/diagnostic_log.dart`）
は、**新しい処理実行のたびに前回のログを意図的に消して新しく書き始める**
設計（`startRun()`メソッドのdocコメントに明記）。

にもかかわらず、3回の「保存済み地点から再開」試行（＝3回のクラッシュ）
を経てもログが一切更新されていない。ただし再開時には、`startRun()`より前に
保存済みチェックポイントの復元やプロセス起動が行われ得る。この事実だけで
Dartエントリーポイントへの未到達を判定することはできない。言えるのは

> 再開処理は、新しい診断ログを開始する地点より前で停止している可能性がある

という範囲までである。到達地点を確定するにはKotlin側の起動確認と
`adb logcat`を併用する必要がある。

### 補強材料：Kotlin側のフェイルセーフも発火していないように見える

`ProcessorService.kt`のFlutterエンジン起動処理（`startFlutterRuntime()`）
は、以下のように丸ごと`try/catch`で囲まれている：

```kotlin
private fun startFlutterRuntime() {
    try {
        // FlutterEngine construction, executeDartEntrypoint(...) など
    } catch (error: Throwable) {
        writeBootstrapFailure(activeStatusPath, error)
    }
}
```

`writeBootstrapFailure()`はステータスファイルに`state: "failed"`,
`stage: "処理システム起動エラー"`という、**現在のUI表示（"中断・再開可能"）
とは明確に異なる状態**を書き込む。ユーザーの画面は毎回同じ
「中断・再開可能」のままだったので、私はこの`try/catch`ブロックも
通過していないと推論した。ただしこれも、`activeStatusPath`が想定通り
セットされていない等の別要因で書き込みが無効化されている可能性を
完全には排除できていない。

### 私の暫定的な見立て（確信度は高くない）

以上は起動・復元経路を優先確認すべき根拠にはなるが、Kotlin/JVM層より
手前のネイティブクラッシュだと断定する根拠にはならない。なお、この
リポジトリには`native/`以下のLibRawを含むC/C++ソースと
`android/app/CMakeLists.txt`が収録されているため、ネイティブ実装も静的調査・
修正の対象にできる。Flutterエンジン初期化、サービス起動競合、Dart側の
復元処理、ネイティブRAW処理を並列の仮説として検証する必要がある。

**この時点で、静的なコード読解だけによる原因特定は限界に達している。**
確定させるには`adb logcat`で取得できるtombstone（ネイティブクラッシュの
システムログ）が必須。

## 3. 私が確認した内容（「シロ」と断定はできない——再確認を推奨）

**重要な注意**：以下は「原因ではないと証明した」リストではない。私は
結局このクラッシュの真因を特定できなかった。特定できなかった調査者が
「ここは調べなくていい」と言うのは筋が通らない。以下はあくまで
「静的にコードを読んだ範囲では疑わしい記述を見つけられなかった」と
いう記録であり、見落としの可能性を前提に、**次の調査者には独立して
再確認してもらいたい**。特に、私はlogcatも実機も無い状態でコードを
読んだだけなので、以下の判断そのものが誤っている可能性は普通にある。

| 確認した仮説 | 確認内容（私が読んだ範囲） | 私の暫定判断 | 再確認すべき理由 |
|---|---|---|---|
| `MainActivity.kt`が誤って別プロセスを`killProcess`している | `processorName = "$packageName:processor"`との厳密一致でのみkillしている | 疑わしい記述は見つからなかった | `ActivityManager.runningAppProcesses`のプロセス名が端末・Androidバージョンによって想定と違う形式で返る可能性は未検証 |
| チェックポイント復元ループでのDart例外がクラッシュに関与 | ファイルI/Oは`await`と`try/catch`で保護されている | 疑わしい記述は見つからなかった | 数百枚規模のJSONを synchronous に近い形で連続読込しており、極端に大きいチェックポイントや破損JSONでの挙動は未検証 |
| `StackOperationJournal`が制御フローに悪影響 | 診断用の追記オンリーに見えた | 疑わしい記述は見つからなかった | 呼び出し元での使われ方まで全箇所は追いきれていない |
| SIGKILLで後始末されないロックファイル等が次回起動と衝突 | `lock`/`mutex`/`pidfile`等のキーワード検索で該当コード無し | 見つからなかった（＝存在しない、ではなく見つけられなかった） | キーワード検索は表記ゆれに弱い。ネイティブ側にファイルロックがある可能性はコードが見えないため未検証のまま |
| 「rolling max」画像の破損データがネイティブに渡ってクラッシュ | 該当フェーズはJSON形式の軽量チェックポイントのみに見えた | 見つからなかった | このアプリ全体を把握しきれていない前提での判断。フル解像度画像を別の場所で永続化していないか、私が見落としている可能性は十分ある |

**次の調査者へ**：上記の「疑わしい記述が見つからなかった」は、あなたが
再検証した結果「実は疑わしい記述があった」となっても全く不思議では
ない。私の判断を鵜呑みにせず、特にlogcat/tombstoneが取得できた際は、
まずそのスタックトレースが指す箇所を優先し、上記の表は参考程度に
扱ってほしい。

## 4. 実施した修正（Work334、未検証・当たっている確信は無い）

念のため明記すると、以下は「原因を特定した上での修正」ではなく、
**「コードを読んでいて気になった設計上の弱点を1つ直しただけ」**である。
これで直る可能性が高いと主張するつもりはない。他に気になった箇所が
無かったわけでもなく、単に一番具体的に手を打てそうだったのがこれ
だった、というのが実情に近い。

`MainActivity.kt`の再起動フローに、以前から次の設計上の弱点があった：

```kotlin
// 変更前
android.os.Process.killProcess(it)
mainHandler.postDelayed({
    requestProcessorLaunch(...)   // 死亡確認なし、固定750ms後に無条件で次を起動
}, 750L)
```

「殺したことを確認せず、決め打ちの時間だけ待って次のプロセスを起動する」
という設計は、それ自体が「新プロセスが旧プロセスの後始末未完了と
競合する」レースコンディションの温床になり得る。これが今回のクラッシュの
確定原因とは証明できないが、**原因の如何に関わらずそれ自体を直す価値が
ある**と判断し、以下の通り変更した：

```kotlin
// 変更後の要旨
private fun awaitProcessorDeathThenLaunch(
    activityManager: ActivityManager,
    processorName: String,
    supervisorRequest: SupervisorStartRequest,
    waiter: ProcessorLaunchWaiter,
    deadlineElapsedRealtimeMs: Long,
) {
    val stillAlive = activityManager.runningAppProcesses
        ?.any { it.processName == processorName } == true
    val timedOut = android.os.SystemClock.elapsedRealtime() >= deadlineElapsedRealtimeMs
    if (stillAlive && !timedOut) {
        mainHandler.postDelayed({ /* 自分自身を再スケジュール */ }, 100L)
        return
    }
    // 死亡確認 or 5秒タイムアウト後、250ms猶予を置いてから起動
    mainHandler.postDelayed({ requestProcessorLaunch(supervisorRequest, waiter) }, 250L)
}
```

- ポーリング間隔100ms、確認後の猶予250ms、全体タイムアウト5秒
- 通常ケースでは以前の固定750msより早く再起動できる
- 後始末が重い端末では、以前の750msでは足りなかった分だけ長く（最大
  5秒まで）待てるようになる
- タイムアウトしても最終的には起動を試みる（永久ハングはしない）

**この修正は未検証**（実機・エミュレータへのアクセスがこの調査環境には
無いため）。ユーザーには実機での再検証を依頼中。

## 5. 派生して見つかった別件（クラッシュとは別問題、参考情報）

同じログから、**1フレームあたり約110〜154秒**という極めて遅い処理速度
が判明した。内訳の内訳：

- `stage=decode`：42〜68秒（ネイティブRAWデコード自体は約5秒で完了して
  いるが、このタイマーはデモザイク・キャリブレーション・ファイル
  バックの中間書き出しまで含めた区間を計測しているため長く出る）
- `stage=streak-brightness`：55〜93秒（フレーム内で最も重い処理。
  `lib/core/session/meteor_pipeline.dart`の
  `extractMeteorCompactFrameFeatures`内で計測されている、ストリーク
  ＝軌跡の輝度サンプリング処理）

336枚では合計25〜30時間規模になり得る。並列化（`ConcurrencyPolicy`の
`maximumWorkers`を1から引き上げる）はメモリ使用量とのトレードオフ、
実際のRAWデコード/デモザイクはネイティブ実装だが、`native/`以下に
ソースが収録されており調査・改善は可能。**これは今回のクラッシュ原因とは
未確定**だが、同じ
ジョブに関する既知の問題として記録しておく。

## 6. 次の調査者へ：優先して確認してほしいこと

前提として、**第3章の「私が確認した内容」は全て再確認の対象**であり、
無視してよい既済チェックリストではない。その上で、特に以下を優先して
ほしい。

1. **最優先**：`adb logcat`（可能なら`--buffer=crash`や`dumpsys
   dropbox`経由のtombstone）を、実際に「保存済み地点から再開」を
   押した瞬間に取得する。これが無い限り、これ以上の静的解析による
   原因特定は困難。
2. ネイティブRAWデコーダー（`lib/core/raw/ffi_raw_native_bridge.dart`
   と`native/`以下のC/C++実装）が、
   **「新規プロセスとしての初回起動」と「killProcess後の再起動」で
   何か初期化条件が変わっていないか**（静的変数、シングルトン、
   ネイティブ側のグローバル状態、GPU/ハードウェアデコーダーハンドル等）
3. Flutterエンジンのネイティブ初期化（`FlutterEngine(applicationContext)`
   のコンストラクタ、AOTスナップショットのロード）が、端末の空き
   ストレージ・空きメモリが著しく低い状態で失敗し得るか
4. 該当ジョブの131番目の元RAWファイル（`00238_DSC03934.ARW`相当、
   実際のファイル名は要確認）自体が破損していないか（ファイルサイズ・
   チェックサムの確認）
5. Work334の「死亡確認ポーリング」修正を実機で検証し、症状が変わるか
   （直る／変わらない／別の症状に変わる、のいずれか）を記録する

## 7. このリポジトリの関連ファイル一覧

```
android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt       (Work334で変更)
android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt   (未変更・調査対象)
android/app/src/main/kotlin/com/mobilestack/app/SupervisorService.kt  (未変更・調査対象)
lib/core/background/standard_stack_background_worker.dart             (未変更・調査対象)
lib/core/background/processor_runtime.dart                            (未変更・調査対象)
lib/core/background/stack_job_status.dart                             (未変更・参照)
lib/core/diagnostics/diagnostic_log.dart                               (未変更・参照)
lib/core/raw/ffi_raw_native_bridge.dart                                (未変更・ネイティブ境界)
lib/core/raw/native_raw_decoder.dart                                   (未変更・ネイティブ境界)
lib/core/demosaic/native_mobile_stack_demosaic_engine.dart             (未変更・ネイティブ境界)
lib/core/session/meteor_pipeline.dart                                  (未変更・streak-brightness計測箇所)
```

なお、この調査に先立ち、同じ`MainActivity.kt`に対して**Android FGS
（フォアグラウンドサービス）起動制限のレース対策**として一連の別件
修正（Work330〜333）を実施済み。それらは本インシデントとは別の症状
（起動拒否のエラー握りつぶし等）に対するもので、本クラッシュとは
直接関係しないと考えているが、`MainActivity.kt`自体が同じファイルの
ため、念のため`WORK330_333_FINAL_SUMMARY.md`も参照されたい。
