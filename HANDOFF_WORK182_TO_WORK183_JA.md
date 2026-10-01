# Mobile Stack 引き継ぎ資料
基準: Work182 + Work183着手時点
作成日: 2026-08-20

## 1. 最重要方針
- 最高画質を最優先する。
- 速度、メモリ、処理時間短縮のために画質を落とさない。
- 画質低下の可能性がある変更は、数理的根拠または実写比較なしに採用しない。
- 最終成果物は、可能な限り線形情報・階調・ハイライト余裕を保持したLinear DNGを主軸とする。
- creative tone mapping / gamma / LUT等をLinear DNGへ焼き込まない。
- 不明点は推測で変更しない。

## 2. 現在の基準
Work182:
mobile-stack-work182-reference-frame-maximum-quality-wip.zip
SHA-256:
6b7a6e4b217ac457759173f69db68ab54625250e3f95529cfeee5cf21eac44ad

この引き継ぎZIP内のプロジェクトはWork182を展開したもの。
Work183（バックグラウンド処理）は調査開始済みだが、まだ実装していない。
したがって、バックグラウンド機能を「実装済み」と扱わないこと。

## 3. Work181で行った最高画質化
### full-resolution registration
通常の天の川スタックで、位置合わせ用画像を最大辺3072pxへ自動縮小していた処理を撤廃。
native resolutionで星検出・PSF centroid refinementを行う。

### saturation-filter修正
usablePreviewStars生成時の自己参照誤記を修正。
また、飽和影響除外後に元のpreviewStarsへ戻ってしまう経路を修正。
飽和影響星がregistration solutionへ再混入しないようにした。

### 高画質default統一
registerAndCombineDecodedFrames:
- usePsfRefinement = true
- useComprehensiveFrameWeighting = true

## 4. Work182で行った最高画質化
従来は「最初に使用可能だったフレーム」をreference frameとしていた。
これを廃止。

通常スタック/CFA Drizzleともに:
1. 全使用可能候補から星検出
2. saturation影響星を除外
3. 既存comprehensiveFrameQualityWeightを再利用したintrinsicReferenceFrameQualityWeightで評価
4. 最も高い品質scoreのフレームをreferenceに選択
5. 同点なら検出星数が多い方を選択
6. 検出済みstar listを後段registrationでも再利用

新しい根拠不明heuristicは作っていない。

## 5. Work180までの重要事項
### CFA Drizzle / reconstruction
- finite value検査
- coverageはfiniteかつnon-negative
- saturation coverageもfiniteかつnon-negative
- Float64→Float32 CFA再構築前にFloat32表現可能範囲を検査
- NaN/Inf伝播経路を防止

### Linear DNG
- 3ch IEEE Float32 LinearRaw
- BitsPerSample=32
- SampleFormat=IEEE floating point
- finite negative値を保持
- 1.0超のfinite値を保持
- export bodyで[0,1] clampしない
- gamma/tone curve/creative LUTを焼き込まない
- Classic TIFF/BigTIFF両経路あり
- DNGVersion=1.4.0.0
- DNGBackwardVersion=1.1.0.0

Adobe実読込互換性はまだ未実証。
後で実DNG生成→Adobe DNG SDK/Converter→Lightroom/Camera Rawで確認すること。

## 6. フル検査時点の結果
Work180時点の全体検査:
- ZIP CRC OK
- 507 files走査
- Node 475/475 PASS
- native clean CMake configure/build PASS
- native CTest 8/8 PASS
- TODO/FIXME/HACK/XXX 0
- Flutter/Dart SDK/Gradleは当時の実行環境になく未実行

その後:
Work181 Node 478/478 PASS / native 8/8 PASS
Work182 Node 482/482 PASS / native 8/8 PASS

注意:
Flutter analyze/test/release APK、Android実機、実DNG Adobe importは未検証。

## 7. まだ根拠なしで変更してはいけない画質parameter
- CFA Drizzle pixfrac = 0.7
- outputScale = 2
- kappa/rejection threshold
- interpolation kernel
- gap-fill radius/threshold
- local polynomial/local registrationの無条件常時ON

これらはデータセット依存または有効画素を損なう可能性がある。
「最高画質だから値を強くする」という変更は禁止。
実写比較または明確な根拠を得てから変更する。

## 8. Work183として追加する機能
長時間スタックをAndroidでバックグラウンド継続可能にする。

必須仕様:
- 他アプリ使用中も処理継続
- 画面OFF/スリープ時も可能な範囲で処理継続
- foreground/background executionをAndroid公式仕様に沿って実装
- 完了通知
- エラー通知
- 最高画質pipelineそのものは変更しない

### 稼働状況表示
必須:
- 進捗率 %
- 経過時間
- 現在工程
- 処理枚数 n/N
- 稼働状態: 処理中/一時停止/待機/完了/エラー等
- 最終更新時刻またはheartbeat
- 通知欄でも処理が生きていることを確認可能にする

### 入れないもの
- 残り時間/ETAは表示しない。
理由: thermal throttling、RAM pressure、I/O、工程差などで誤差が大きく、虚偽的な表示になり得るため。

### heartbeat
%が長時間変化しない工程でも停止と誤認しないよう、
heartbeat/最終更新を定期更新する。
単なるUI timerだけで「処理中」と偽装せず、worker側の実処理活動を反映する設計にすること。

## 9. Work183調査で確認済みの現状
pubspec dependencies:
- flutter
- ffi
- file_picker
- path
- share_plus
現状、WorkManager/notification系dependencyは未導入。

AndroidManifest:
foreground service/background processing用permission/serviceはまだ未追加。

CFA Drizzle progress screen:
現在は画面内で直接runCfaDrizzleMilkyWayPipelineをawaitしている。
進捗は0～70% pipeline、70～100% exportという単一double表示。
画面を離れても独立して継続するpersistent worker構造にはまだなっていない。

現在のUIには% progress barはあるが、
- 経過時間
- 現在工程
- n/N
- heartbeat
- notification
は未実装。

## 10. バックグラウンド化で絶対に守ること
UI isolateからworkerへ移した結果として、
- 解像度を落とさない
- PSF refinementを切らない
- comprehensive weightingを切らない
- robust rejectionを勝手に切らない
- DNG precisionを落とさない
- JPEG等へ置換しない
- memory節約目的で画像品質parameterを変えない

必要ならfile-backed/tile/streamingを利用してRAMを制御する。
画質parameterではなく実装方式でメモリ問題を解決する。

## 11. 現在確認された設定上の注意
CFA Drizzle高画質画面:
- enableRobustRejection default true
- useComprehensiveFrameWeighting default true
- usePsfRefinement default true
- enableLocalRegistration default false

local registrationは「重いからfalse」という過去コメントが残る。
最高画質方針として再査定対象だが、常時ONが必ず高画質とは未証明なので、
実写/数理根拠なしでtrue固定にしないこと。

Android release buildにはdebug signingConfigが残っている。
最終配布前にrelease signingへ変更が必要。これは画質とは無関係。

## 12. 次に行う順序
1. Work182を基準にWork183 background architectureを実装
2. Android foreground/background service / persistent work方式を公式仕様で確定
3. pipeline progressを工程名+n/Nまで構造化
4. worker heartbeatを実処理側から更新
5. persistent notificationに%/工程/n/N/経過時間/heartbeatを表示
6. 完了/エラー通知
7. UI復帰時にworker状態を再接続
8. process death/restart時の扱いを明確化
9. Node/native回帰
10. Codex/Flutter環境で flutter analyze/test/build
11. Pixel 9 Proでバックグラウンド/画面OFF/thermal/RAM実測
12. α7 V 33MP RAW×複数枚で実測
13. 最終DNGをAdobe系で検証

## 13. 性能予測について
α7 V 33MP RAW×50枚をPixel 9 Proで最高画質stackする所要時間は未実測。
以前の30～60分という値は机上予測であり、保証値ではない。
最終的にはPixel 9 Pro実測で確定する。

速度改善を行う場合も、最高画質を絶対条件として、
I/O、tile scheduling、buffer reuse、並列化等のlossless optimizationを優先する。
