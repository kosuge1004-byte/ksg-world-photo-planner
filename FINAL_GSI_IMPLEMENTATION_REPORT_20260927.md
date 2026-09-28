# AstroSight 国土地理院データ統合・高速化 最終報告

作成日: 2026-09-27  
使用承認: 国地情使 第402号（GIS「astrosight」作成のため）

## 1. 結論

- 国内ジオイド高はJPGEO2024をWorker内で計算し、通常利用で国土地理院の旧CGIを呼ばない。
- 一括方位ダウンロードとライブ三脚候補探索の両方が同じローカルジオイド経路を使う。
- 方位データは最大64方位ずつまとめるバッチAPIへ切り替え、259方位を5 HTTPリクエストで処理できる。
- DEM取得失敗は失敗点だけ最大2回再試行してから方位失敗を判定する。
- R2は停止・削除せず、検索で必要になった小さなDEM/APIキャッシュを共有する。
- 全国DEMや約80–85GBの選択DEMをR2へ一括投入しない。R2の新規保存予約を4GBに制限する。
- 三脚候補の精度順序、座標、補間方式、NoData・水面判定は変更していない。
- Cloudflareへのアップロード・デプロイは実施していない。

## 2. データの保存場所・使用方法・容量

| データ | 保存場所 | 本番での使い方 | 容量 |
|---|---|---|---:|
| ジオイド公式原本 | `geoid/` | 再生成・照合用 | 公式48 ZIP 169,721,419 B（161.86 MiB） |
| 本番ジオイド | `server/data/jpgeo2024.generated.ts` | Worker内の配列参照・バイリニア補間 | 2,932,908 B（2.80 MiB） |
| DEM公式原本 | `E:\AstroSight-GSI-data-20260926\dem\official-archive` | 形式・精度検査、選択変換の原本 | 16/275 ZIP、12.803 GiB取得済み |
| DEM代表検査データ | `dem/` | 1m/5m/10m変換・補間・NoData検査 | 4 ZIP、約1.085 GiB |
| 本番DEMキャッシュ | Cloudflare R2 `NETWORK_CACHE` | 実検索・先読みで必要なタイルだけ保存 | 新規予約上限4,000,000,000 B |

全国DEMの公式一覧は275 ZIP、推定492.000 GiBである。現在の内訳はDEM10が11/11
（6.746 GiB、全国分完了）、DEM5が4/20（5.872 GiB）、DEM1が1/244（0.185 GiB）。
残り259 ZIP、推定479.197 GiBは本番運用に不要なため、現時点では取得を進めない。

富士山だけを山岳先読み対象とし、城・建築物・塔・寺社・テーマパーク・観覧車を
すべて残した対象は195件である。10km圏の公式GML原本推定は79.710 GiBなので、
これも一括アップロードせず、実際に通るタイルだけをR2へ段階的にキャッシュする。
スポット検索カタログは284件のままであり、山を検索対象から削除していない。

## 3. データ形式

### JPGEO2024

- ISG 2.0、UTF-8、BOMなし、CRLF、28行ヘッダー
- 北緯15–50度、東経120–160度
- 2,101行 × 1,601列 = 3,363,701点
- 緯度1分、経度1分30秒
- 並びは北→南、各行は西→東
- 単位m、NoData `-9999.0000`
- AstroSightでは`JPGEO2024`を使用し、楕円体高は`h = H + N`

### 都道府県別ジオイドGML

- UTF-8 XML、座標は緯度・経度
- 1次メッシュごとに320 × 320点
- 緯度7.5秒、経度11.25秒
- `+x-y`（西→東、その後北→南）、単位m

### DEM GML

- 地方区分ZIP → 2次メッシュZIP → UTF-8 GML XMLの二重ZIP
- 値は`分類,標高`、単位m、正高
- 走査順`+x-y`、座標記載は緯度・経度
- DEM1は約0.04秒、DEM5は約0.2秒、DEM10は約0.4秒の実例を確認
- 数値`-9999`は分類名に関係なくNoData、0mは有効値

詳細は`docs/gsi-data-format-report.md`を参照。

## 4. 主な実装

### ジオイド

- `server/data/jpgeo2024.generated.ts`: 国内範囲2,038,071点の可逆圧縮データ
- `server/jpgeo2024Local.ts`: 必要タイルだけ復元するLRUとバイリニア補間
- `server/gsiGeoid.ts`: ローカル優先、国内では外部CGIなし
- `functions/api/gsi-geoid.ts`: GET・POST双方をローカル計算へ統合
- `src/cesium/worldTerrain.ts`: 地域まとめ・点単位高精度の両経路を統合

### DEM・方位バッチ

- `server/gsiLocalDem.ts`: GMLバイナリ、境界近傍、NoData、補間、R2読取
- `server/gsiElevation.ts`: ローカルGML優先、欠落点だけ既存公開タイルへフォールバック
- `scripts/prepare-gsi-dem-r2-assets.mjs`: ZIPを展開せずメッシュ別gzipへ変換
- `server/bearingProfileBatch.ts` / `functions/api/bearing-profile-batch.ts`: 最大360方位のまとめ処理
- `src/cache/bearingProfileBatchClient.ts`: 最大64方位単位の少数リクエスト
- `src/cache/tripodBearingProfileManager.ts`: バッチ利用とDEM失敗点の個別2回再試行

### R2無料枠・先読み

- `server/r2SafetyBudget.ts`: 新規4GB、月10万書込、月100万読取をD1で強制
- 4つのWrangler設定で同じ`NETWORK_CACHE` R2と`R2_WRITE_BUDGET_DB` D1を共有
- `server/landmarkPrewarmSeed.ts`: 284件の原簿を維持し、先読みは富士山＋非山岳194件
- Cron、Pages API、Queue consumer、手動CLIを同じ安全ガードへ統一

### UI

- 不要なハンバーガーメニュー項目を整理し、設定バー・ダウンロード管理の導線を統合
- 方位ダウンロード中の地形・ジオイド進捗と失敗内容を表示

## 5. 精度検証

JPGEO2024のローカル補間値を旧CGIと比較した。

| 地点 | CGI (m) | ローカル (m) | 絶対差 |
|---|---:|---:|---:|
| 東京 | 36.7614 | 36.7614428502 | 0.00429 cm |
| 大阪 | 37.5925 | 37.5924821578 | 0.00178 cm |
| 札幌 | 32.1957 | 32.1957189607 | 0.00190 cm |
| 福岡 | 32.5869 | 32.5868724703 | 0.00275 cm |
| 那覇 | 30.8471 | 30.8470542501 | 0.00457 cm |

最大差は0.00004575 m（0.004575 cm）で、数cm以内という条件を十分満たした。
格子ノード、内部タイル境界、外周境界でも原値の可逆性を確認した。

沿岸・河川・湖・外洋はGSI z16水域ポリゴンで点順を保って判定し、NoDataを0mへ
誤変換しないこと、河川は近傍陸地正高を使うこと、未知領域を水面と推測しないことを
回帰テストで確認した。

## 6. 259方位の計測

実アプリ条件の259方位、14,245点、55距離段階で計測した。

| 条件 | 時間 | HTTP相当 | R2相当読取 | 外部通信 | 失敗方位 |
|---|---:|---:|---:|---:|---:|
| 初回 | 835.446 ms | 5 | 7 | 0 | 0 |
| メモリ再利用 | 127.572 ms | 5 | 0 | 0 | 0 |

旧方式の方位別100回超の往復を5回へ削減した。旧本番CGI・公開タイルの応答時間は
外部状況で変わるため同一条件の秒数比較は行わず、再現可能な新経路の実測値と
リクエスト数の比較を記録した。

## 7. 最終検査

- `npm test`: 62/62回帰グループ PASS
- `scripts/run-all-verifications.mjs`: 113/113 PASS
- GSI重点テスト: 29/29 PASS
- GSI ZIP中央ディレクトリ・代表ペイロード: 68/68 PASS
- ジオイド都道府県: 47/47、公式ZIP 48/48
- `npm run build`: PASS
- `npm run lint -- --quiet`: PASS
- Cloudflare Pages Functions build: PASS
- spot-search / bearing-profile / prewarm Worker dry-run: 3/3 PASS
- R2無料枠ポリシー検査: PASS

証跡は`evidence/`に保存した。巨大なDEM原本、`node_modules`、Wrangler一時出力は
最終アプリZIPへ入れず、Eドライブの原本保管を継続する。
