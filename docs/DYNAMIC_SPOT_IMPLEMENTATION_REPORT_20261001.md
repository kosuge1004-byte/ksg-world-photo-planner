# Dynamic Spot 実装・検査報告（2026-10-01）

## 実装結果

未登録地点を静的ランドマークリストとは別の `Dynamic Spot` として端末およびEドライブへ保存し、正確な検索座標を使った10 km・360方位の地形プロファイルをバックグラウンド生成する経路を追加した。既存の静的リスト、既存R2、既存三脚候補計算式は変更していない。

検索順序は次のとおり。

1. 静的ランドマーク
2. 端末のDynamic Spot
3. EドライブのDynamic Spot
4. 既存の通常検索

検索結果は360方位の完成を待たずに利用できる。PCまたはEドライブへ接続できない場合は端末へ `pending` として保存し、検索と撮影計画を継続する。Eドライブ接続回復後は未完了方位だけを再開する。

## 保存場所

標準のローカルDEMルートが `E:\AstroSight-GSI-data-20260926\dem\r2-ready` の場合、Dynamic Spotは次へ保存する。

```text
E:\AstroSight-GSI-data-20260926\dynamic-spots-v1\
  manifest.json
  spots\dynamic-<sha256-prefix>.json
  profiles\<dynamic-spot-id>\
    bearings\000.json ... 359.json
    complete.json.gz
```

不足DEMの永久キャッシュは既存形式を維持する。

```text
E:\AstroSight-GSI-data-20260926\dem\r2-ready\
  gsi-decoded-dem-v2\<source>\<zoom>\<x>\<y>.bin
```

DEMタイルはスポット別に複製せず、全Dynamic Spotで共有する。実測で作成した試験用Dynamic Spotカタログは検査後に削除した。実測中に取得した共有DEMキャッシュは再利用可能なため保持した。

## Dynamic Spot schema

`DynamicSpotRecord` はID、名称、別名、座標、カテゴリ、地形／構造物区分、構造物高、高さの出典種別・URL・表示名・検証状態、DEM生成状態、10 km、360方位、作成・更新日時、8桁小数の座標キー、プロファイル版、進捗、エラー、完成ファイル容量、SHA-256を保持する。

構造物高は、検証済み公式値、PLATEAU実測、OSM `height`、OSM `building:levels` 推定の順で採用する。PLATEAUとOSMは公式値として保存しない。高さを取得できない構造物は `unknown/pending` のままとし、0 m、地形地点、完成データへ変換しない。

## 計算経路と精度

正式スポットと同じ `server/bearingProfileBatch.ts`、`server/gsiLocalDem.ts`、JPGEO2024、DEM優先順位、補間、距離配列を共有する。条件は10 km、0～359度、各方位352点、合計126,720点。近隣プロファイルの平行移動流用は行わない。

完成判定では、名称、座標、地形／構造物区分、高さ、出典、360/360方位、10 km、全値finite、座標一致、高さ一致、再読込、SHA-256を検証する。方位ごとの一時ファイルを検査後にatomic renameし、359方位以下は完成にしない。

端末へ完成プロファイルを取り込む処理は360方位を1回の計算済みプロファイル応答で取得し、計算済みデータの取得に失敗しても54分経路へ自動移行しない。

## APIとセキュリティ

追加したAPIは検索、登録、状態取得、再試行の固定4経路だけである。名称、座標、高さ、出典等の構造化データだけを受け取り、パス、ファイル名、ディレクトリ、削除要求を拒否する。保存先とファイル名はローカルサービスが決定する。既存の独立した認証シークレットとリクエスト制限を通る。

新規有料API、新規Cloudflareバインディング、R2必須処理は追加していない。R2の既存正式スポット経路と無料枠保護は維持した。

## 360方位実測

すべて同じWindows PC、Eドライブ実データ、10 km、360方位、126,720点で測定した。PLATEAUとOSMの2条件は高さ解決後の入力から360方位完成までを測定している。ローカルNode実測はブラウザ／Cesium画面を描画しないため、「検索開始から被写体表示まで」は未測定であり、予測値を記載しない。

| 条件 | 登録受付 | 360方位完成 | 完成gzip | Dynamicストア増加 | DEMキャッシュ増加 | 外部要求 | 2回目 |
|---|---:|---:|---:|---:|---:|---:|---:|
| terrain / DEM既キャッシュ | 124.1 ms | 22.720秒 | 1,127,878 B | 6,888,204 B | 0 B | 0 | 134.2 ms |
| terrain / DEM未キャッシュ | 89.7 ms | 355.435秒 | 1,135,079 B | 6,943,440 B | 380,389,950 B | 7,398 | 271.3 ms |
| structure / PLATEAU解決済み | 216.8 ms | 285.422秒 | 1,082,067 B | 6,787,826 B | 105,391,069 B | 5,965 | 238.7 ms |
| structure / OSM fallback解決済み | 116.0 ms | 311.188秒 | 1,086,159 B | 6,727,120 B | 945,063,862 B | 5,902 | 162.5 ms |

外部要求はすべて `cyberjapandata.gsi.go.jp` の不足DEMタイル取得である。2回目は4条件とも外部要求0。今回の未キャッシュ測定で共有DEMキャッシュへ追加された合計は1,430,844,881 B（約1.33 GiB）。

## 検査結果

- TypeScript `tsc -b`: 合格
- production build: 合格
- 全回帰テスト: 75グループ合格
- Dynamic Spot必須項目A～O: 11/11合格
- 全verify: 118/119合格
- lint: エラー0（基準ソース由来の警告あり）
- ローカルDEM 5地点: 東京・大阪・札幌・福岡・那覇すべてローカル解決、HTTPと直接参照の最大差0 m
- 基準ZIP照合: `src/data/japanLandmarks.ts`、`server/landmarkPrewarmSeed.ts`、`LANDMARK_DATA_RULES.md` はSHA-256完全一致

verifyの唯一の不合格は `verify-android-native.mjs`。基準ZIPにCapacitor Androidプロジェクトまたは同期済みAndroid Web資産が存在しないためで、今回のWebアプリ／Dynamic Spot変更による不合格ではない。

`npm audit` はCritical 0、高12、中5、合計17件。`package-lock.json`は基準ZIPから変更しておらず、互換性を壊す自動更新は行っていない。

## 変更ファイル

主な変更は次のとおり。

- `src/App.tsx`, `src/App.css`: 自動登録、非モーダル進捗、再試行、完成プロファイル取込
- `src/search/spotPresetSearch.ts`: STATIC → DYNAMIC LOCAL → Eドライブ → 通常検索、高さ出典伝播
- `src/cache/dynamicSpotData.ts`: 端末Dynamic Spot保存とEドライブAPI
- `src/cache/tripodBearingProfileManager.ts`: 360方位一括取込と低速フォールバック禁止オプション
- `src/cache/downloadedSpotData.ts`: 旧データ互換のoptionalメタデータ
- `src/types/dynamicSpot.ts`: schemaと厳格な完成判定
- `server/localDemGateway.ts`, `server/placeGeocode.ts`: Dynamic SpotゲートウェイとOSM出典
- `tools/local-dem-server/dynamicSpotStore.ts`: 永続保存、atomic write、SHA、再開、完全性検証
- `tools/local-dem-server/app.ts`, `server.ts`: 固定APIと起動時再開
- `functions/_shared/dynamicSpotApi.ts`, `functions/api/dynamic-spot-*.ts`: Pages API
- `tests/regression/dynamic-spots.test.mjs`: A～O回帰検査
- `scripts/benchmark-dynamic-spots.mjs`: 4条件実測
- `docs/DYNAMIC_SPOTS.md`: 運用仕様

## 未測定事項

GitHub pushおよびCloudflare deployは行っていない。そのため、実際のスマートフォンと公開環境を使った「検索開始から被写体が画面へ表示されるまで」の4条件実測は未実施。コード上は360方位生成を待たずに表示処理を継続する。

## 2026-10-02 追記

### スポットと事前計算範囲

- `曽爾高原（奈良県）` を地形スポットとして正式リストと事前計算対象へ追加した。
- `亀山峠（三重県・奈良県境）` を地形スポットとして正式リストと事前計算対象へ追加した。
- 富士山だけは登録座標を中心とする半径100 km・360方位を事前計算する。通常スポットの10 kmおよび一般検索の上限・サンプリング条件は変更していない。
- 100 km要求は登録済み富士山の正確な座標・距離に一致する場合だけサーバーが受け付ける。一般地点が誤って100 km計算へ入ることはない。

Eドライブの正式スポットプロファイルを再生成・監査した結果は次のとおり。

| 対象 | 距離 | 方位 | 地形点 | gzip | 初回生成実測 |
|---|---:|---:|---:|---:|---:|
| 富士山 | 100 km | 360 | 1,205,280 | 10,825,981 B | 4,747.6秒 |
| 曽爾高原 | 10 km | 360 | 126,720 | 約1.08 MiB | 179.8秒 |
| 亀山峠 | 10 km | 360 | 126,720 | 約1.08 MiB | 134.4秒 |

富士山の4,747.6秒はEドライブ上へ100 kmデータを最初に生成した所要時間であり、アプリで完成済みデータを読み出す時間ではない。監査対象は203スポット、203ファイル、合計233,804,914 B（約222.97 MiB）、地形点26,802,720点で、欠落・孤立ファイル・非finite値・距離不一致は0件だった。

全国DEMを追加取得する処理は実行していない。富士山100 km用の取得候補マニフェストは339メッシュ・1,022ファイル・39.932 GiBだが、これは取得可能ファイルの合計であり、自動ダウンロード量ではない。既存DEMと不足タイルのオンデマンド取得・共有キャッシュ方針を維持する。

### 2D/3D切替

下部地図の右上操作列へ、`現在地` ボタンと同じ寸法の切替ボタンを追加した。2D表示中は `3D`、3D表示中は同じ位置に `2D` を表示する。ブラウザ実測では両ボタンとも幅41.992 px、高さ37.995 pxで、2Dから3D、3Dから2Dへの切替を確認した。

下部地図の2Dと3Dは同一画面へ重ねる方式ではなく、Reactの条件分岐で片方だけをマウントする排他的な切替である。3Dへ切り替えるとMapLibre 2Dインスタンスを `remove()` して通信・イベント・WebGL資源を解放する。2Dへ戻ると3D地図用のrequestAnimationFrameを即時キャンセルし、Cesiumの入力も無効化する。Cesiumの既定描画ループは常時OFFで、2D表示中に3D地図が裏で連続描画されることはない。上部の撮影プレビューは既存機能として必要時だけ静止フレームを要求し、下部3D地図の連続ループとは別管理である。

### 3Dカメラのスワイプ補正

Android Camera2情報からカメラ画角を特定できない端末では、投影情報が空のためスワイプ処理が開始前に終了していた。画角情報が取得できる端末では実測画角を使い、取得できない端末では安全な60度の水平画角と画面比率から求めた垂直画角を使うよう修正した。主ボタンのポインターだけを受け付け、操作部品上のジェスチャーを除外し、pointer captureで画面外へ動いた場合も補正を継続し、終了時に補正値を保存する。

### 追記分の検査

- TypeScript `tsc -b`: 合格
- production build: 合格
- 全回帰テスト: 75グループ合格
- 追加した地図切替・スワイプ補正回帰テストを含む対象テスト: 合格（排他的マウント、2D破棄、3Dループ停止を含む）
- 静的ランドマーク検索: 289件合格
- ランドマークDEMカバレッジ: 289/289合格
- 3D map input verify: 6/6合格
- Eドライブ事前計算プロファイル監査: 203/203合格
- lint: エラー0（既存警告のみ）

GitHub pushおよびCloudflare deployは行っていない。
