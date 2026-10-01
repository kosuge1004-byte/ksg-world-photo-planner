# Work187 Codex-first 引き継ぎ（2026-08-20）

## 目的
Work186までの最高画質パイプラインを維持したまま、ChatGPT環境では実行できないFlutter/Android実機検証をCodex側で先に完了させる。
Codex完了後は、その結果を基準にCodexまたはChatGPTで次工程へ進む。

## 絶対条件
- 画質を落とす修正は禁止。
- RAW decode / calibration / demosaic / registration / CFA Drizzle / robust combine / reconstruction / Linear DNG のアルゴリズム・係数・閾値を、ビルドを通す目的で変更しない。
- 残り時間（ETA）は表示しない。
- 長時間処理では、進捗率、経過時間、現在工程、処理枚数、最終更新/heartbeat、稼働状態を維持する。
- テスト失敗を「テストを削除・skip・期待値緩和」で通さない。
- 未確認事項をPASS扱いしない。

## ChatGPT側でWork186後に先行実施済み
1. Work186 ZIPを展開し、CI定義とAndroid設定を再確認。
2. Workmanager 0.10.7の公開API/公式リポジトリを確認。
   - `getWorkInfo`
   - `ExistingWorkPolicy.keep`
   - `onTaskStopped`
   - `ForegroundServiceConfig`
   が0.10.7系で利用される構成であることを確認。
3. `android/gradle.properties` の `workmanager.enableDataSyncForegroundService=true` を確認。
4. Workmanager公式側では、このopt-inによりlong-running worker用dataSync foreground service宣言をmerged manifestへ追加する設計であることを確認。
5. CIがFlutter 3.44.7 / Java 17 / Android arm64 debug APKを基準にしていることを確認。
6. このChatGPT実行環境には Flutter / Dart / adb が無いため、Flutter依存解決・analyze・test・APK build・実機試験は実行不能。ここは未検証のままCodexへ渡す。

## Codexで最初に必ず実行すること
プロジェクトルートで:

```bash
bash tool/work187_codex_preflight.sh
```

このスクリプトは以下を順番に行う:
1. Flutter/Dart/Javaの存在確認
2. Flutter version記録
3. `flutter clean`
4. `flutter pub get`
5. `pubspec.lock`再生成/更新
6. `flutter analyze`
7. `flutter test`
8. Android arm64 debug APK build
9. APK内 `libmobile_stack_raw.so` の存在確認
10. Android arm64 native ABI export確認
11. Node host tooling tests
12. Native Release CTest
13. LinuxならASan/UBSan CTest

途中で1つでも失敗したら、その失敗を修正して同じスクリプトを最初から再実行する。
修正時に画質系コードを触る必要があるように見えた場合は、そこで止まり、原因を報告する。安易に画質系コードを変更しない。

## Flutter/Android buildがPASSした後
USBデバッグ有効のPixel 9 Proを接続して:

```bash
adb devices
bash tool/work187_pixel_process_death_test.sh
```

### 実機試験A: 通常バックグラウンド
- 実RAW 2枚以上で最高画質/CFA Drizzleを開始。
- 通知に処理中表示が出ること。
- ホームへ戻っても処理が継続すること。
- アプリへ戻ると同一jobへ再接続すること。
- 二重jobが作られないこと。
- 進捗率/経過時間/工程/処理枚数/heartbeatが復元されること。
- ETAが表示されないこと。

### 実機試験B: process death
`force-stop`ではなく通常のprocess deathを先に検証する。
1. 処理中にアプリをバックグラウンドへ。
2. `adb shell am kill com.mobilestack.app`
3. WorkManager状態を採取。
4. ランチャーからアプリを再起動。
5. 前回jobが検出されること。
6. running/scheduledなら新規jobを作らず既存jobへ接続すること。
7. succeededなら既存result.dngへ到達できること。
8. failed/cancelledなら古いrunning表示を永久保持しないこと。
9. 「もう一度開始」を連打しても二重スタックしないこと。

### 実機試験C: force-stopは別試験
`adb shell am force-stop com.mobilestack.app` は通常process deathとは意味が異なるため、試験Bと混同しない。
force-stop後にworkerが走り続けることを合格条件にしない。再度ユーザーがアプリを起動した後の状態整合性を確認する。

### 実機試験D: 失敗時
入力ファイル消失等でworkerを失敗させ、
- statusがfailedになる
- OS側で勝手な無限retryにならない
- 次回新規jobを開始できる
ことを確認する。

## Codexが残す成果物
- `WORK187_CODEX_RESULTS.md`
- `work187_logs/`
  - `flutter-version.txt`
  - `pub-get.txt`
  - `analyze.txt`
  - `flutter-test.txt`
  - `android-build.txt`
  - `android-abi.txt`
  - `node-tests.txt`
  - `native-release.txt`
  - `native-sanitized.txt`（実行可能環境のみ）
  - `adb-device.txt`
  - `adb-workmanager-before.txt`
  - `adb-workmanager-after-kill.txt`
  - `adb-workmanager-after-relaunch.txt`

各項目を PASS / FAIL / NOT RUN で明記する。未実行をPASSにしない。

## Codex完了後にChatGPTへ渡すもの
1. Codexが更新したプロジェクト全体ZIP
2. `WORK187_CODEX_RESULTS.md`
3. `work187_logs/`

ChatGPTは受領後、ログ・差分・画質系変更有無を監査してからWork188へ進む。

## Work188以降
Work187が全PASSなら:
1. process-death結果監査
2. Android 15+ dataSync制限への製品設計上の対処確認
3. 実RAWでLinear DNG生成
4. Adobe Lightroom / Camera Raw等で実読込
5. DNGメタデータ/色/黒レベル/白レベル/マスクの実ファイル検証
6. 最高画質を落とさず残課題を順に実装

FAILがあればWork188へ進まず、そのFAILを最優先で直す。

## Work191追記（最新基準）
Codexへ渡す時点ではWork191を最新基準とする。
Work191では局所残差補正をmedian/MADによる保守的な1回再フィットでロバスト化し、最高画質CFA経路の局所位置合わせを既定ONにした。
Codexでは `WORK191_ROBUST_LOCAL_REGISTRATION_QUALITY.md` と `HANDOFF_CHECKPOINT_WORK191.txt` を先に確認すること。
特に実RAWで local registration ON/OFF のA/Bを行い、ONが悪化する画像がないか確認する。実測前に補正次数・最大補正量・pixfrac・outputScaleを勝手に変更しない。
