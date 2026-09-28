# AstroSight EドライブDEM・被写体屋上高修正 最終報告

作成日: 2026-09-28  
国土地理院使用承認: 国地情使 第402号（GIS「astrosight」作成のため）

## 結果

- 国内ジオイド高は同梱JPGEO2024から配列参照とバイリニア補間で算出する。通常の国内座標では旧CGIを呼ばない。
- 一括方位ダウンロードとライブ三脚候補探索の両方を同じローカルジオイド経路へ統合した。
- Eドライブ上の変換済みDEMを、認証付き読み取り専用API経由でPages/Workersから利用できるようにした。Eドライブをファイル共有や直接公開する構成ではない。
- DEMの精度順は `DEM1A → DEM5A → DEM5B → DEM5C → DEM10B` を維持し、各段階で `R2 → Eドライブ → 公開GSI` の順に参照する。Eドライブ停止・未収録・NoData時は従来経路へ戻る。
- 方位データは最大64方位ずつのバッチAPIへ切り替え、259方位を5 HTTPリクエストで処理する。DEMの一過性失敗は失敗点だけ最大2回再試行する。
- スポット検索の被写体ピンは、建物・城・塔・寺社・観覧車など構造物と判明した場合に地上高へ戻さず、複数候補から最上部を選ぶ。屋上高を確定できなければ明示的な失敗にし、地面を屋上として採用しない。
- R2は停止していない。既存の無料枠ガード（新規4 GB、月10万書込、月100万読取）を維持した。課金契約、GitHubへのpush、Cloudflareへのアップロード・デプロイは実施していない。

## 保存場所、用途、容量

| データ | 保存場所 | 用途 | 容量 |
|---|---|---|---:|
| ジオイド公式原本 | `geoid/` | 再生成・照合 | 48 ZIP、169,721,419 B（161.86 MiB） |
| 実行用ジオイド | `server/data/jpgeo2024.generated.ts` | Worker内の国内ジオイド計算 | 2,932,908 B（2.80 MiB） |
| DEM公式原本 | `E:\AstroSight-GSI-data-20260926\dem\official-archive` | 変換元・再検査 | 16 ZIP、13,746,661,475 B（12.803 GiB） |
| 変換済みDEM | `E:\AstroSight-GSI-data-20260926\dem\r2-ready\gsi-local-dem-v1` | ローカルDEM APIの実データ | 95,107アセット、gzip 10,183,725,395 B（9.484 GiB） |
| R2 `NETWORK_CACHE` | Cloudflare | 実検索で必要になった小容量キャッシュ | 無料枠ガード内 |

取得済み公式DEMはDEM10が11/11で全国分、DEM5が4/20（北海道3、近畿1）、DEM1が1/244（中部1）である。全国DEM1/5をすべて取得した状態ではなく、未収録地域の高解像度データは公開GSIへフォールバックする。公式一覧275 ZIPの推定総量は492.000 GiBであり、全件をCloudflareへ置く設計にはしていない。

スポット検索カタログ284件は維持した。先読み対象は富士山と山以外の城・ランドマーク・塔・タワーなど全194件を合わせた195件である。他の100名山は検索から削除していない。

## 実データ形式

### ジオイド

- JPGEO2024: ISG 2.0、UTF-8、28行ヘッダー、2,101 × 1,601点。
- 範囲は北緯15～50度、東経120～160度。緯度1分、経度1分30秒。
- 並びは北から南、各行は西から東。単位m、NoDataは `-9999.0000`。
- 都道府県別GMLは緯度・経度順、`+x-y`、320 × 320点、緯度7.5秒・経度11.25秒。

### DEM

- 地方区分ZIPの中に2次メッシュZIP、その中にGML XMLがある二重ZIP。
- 文字コードはUTF-8とShift_JIS/CP932が実在する。変換器はXML宣言を判定して厳格にデコードする。
- bboxは緯度・経度順、走査順は西から東・北から南の `+x-y`。
- 値は `分類,標高`、単位mの正高。数値 `-9999` はNoDataで、0 mとは区別する。
- 変換済み値はsigned int32のcm単位。`-2147483648`をNoDataとして保持する。
- 実変換結果はDEM10A 96、DEM10B 4,885、DEM1A 136、DEM5A 74,305、DEM5B 6,284、DEM5C 9,401アセット。7,019,839,152タプルを処理し、省略表現のNoData 146,635,848セルも復元した。

詳細は `docs/gsi-data-format-report.md` を参照。

## 実装の要点

- `server/jpgeo2024Local.ts`, `server/gsiGeoid.ts`, `functions/api/gsi-geoid.ts`: 国内ジオイドのローカル計算とCGIフォールバック。
- `server/gsiLocalDem.ts`, `server/gsiElevation.ts`: 変換済みGMLアセットの補間、R2・Eドライブ・公開GSIの精度順制御。
- `server/localDemGateway.ts`, `server/cloudflareRuntime.ts`: HTTPS固定パス、Access Service Token、独立オリジントークン、2秒タイムアウト、回路遮断、応答上限、リクエスト単位の実行状態。
- `tools/local-dem-server/`: `127.0.0.1`のみで待ち受ける認証付き読み取り専用API。ファイル一覧・任意パス・書込・削除APIは持たない。
- `scripts/prepare-gsi-dem-r2-assets.mjs`: 二重ZIPをストリーム処理し、UTF-8/Shift_JIS、疎なtupleList、NoDataを検証してgzipアセットへ変換。中断再開と決定的出力に対応。
- `server/bearingProfileBatch.ts`, `functions/api/bearing-profile-batch.ts`, `src/cache/bearingProfileBatchClient.ts`, `src/cache/tripodBearingProfileManager.ts`: 全方位バッチと失敗点の個別再試行。
- `src/height/subjectSurfaceResolution.ts`, `src/height/osmSubjectHeightFallback.ts`, `src/search/spotPresetSearch.ts`, `server/placeGeocode.ts`, `src/precision/highestPrecision.ts`, `src/App.tsx`: 構造物の屋上高を一元判定し、履歴・共有・プロジェクト復元後も地上高へ降格させない。
- `server/r2SafetyBudget.ts`, `server/landmarkPrewarmSeed.ts`: R2無料枠制御と富士山＋全非山岳ランドマークの先読み。

## 精度と動作検査

### ジオイド5地点

| 地点 | 旧CGI (m) | ローカル (m) | 絶対差 |
|---|---:|---:|---:|
| 東京 | 36.7614 | 36.7614428502 | 0.00429 cm |
| 大阪 | 37.5925 | 37.5924821578 | 0.00178 cm |
| 札幌 | 32.1957 | 32.1957189607 | 0.00190 cm |
| 福岡 | 32.5869 | 32.5868724703 | 0.00275 cm |
| 那覇 | 30.8471 | 30.8470542501 | 0.00457 cm |

最大差は0.00004575 m（0.004575 cm）で、要求された数cm以内を満たした。

### EドライブDEM API 5地点

| 地点 | 採用データ | 標高 (m) | APIと直接参照の差 |
|---|---|---:|---:|
| 東京 | DEM10B | 3.4 | 0 m |
| 大阪 | DEM10B | 0.8 | 0 m |
| 札幌 | DEM5A | 17.88 | 0 m |
| 福岡 | DEM10B | 3.7 | 0 m |
| 那覇 | DEM10B | 6.5413895217 | 0 m |

認証付きループバックAPIで全5地点をローカル解決し、同一アセットの直接参照と完全一致した。沿岸・河川・湖・外洋について、NoDataを0 mへ変換しないこと、水面判定の点順、河川で近傍陸地正高を使うこと、未知領域を水面と推測しないことを回帰検査した。

### 259方位

中部DEM1収録範囲で、259方位 × 55距離 = 14,245点を外部通信禁止条件で実測した。

| 条件 | 処理時間 | HTTP相当 | ローカル読取 | 外部通信 | 失敗方位 |
|---|---:|---:|---:|---:|---:|
| 初回 | 766.103 ms | 5 | 7 | 0 | 0 |
| メモリ再利用 | 127.745 ms | 5 | 0 | 0 | 0 |

従来の100回超のクライアント往復を5回へ削減した。旧公開CGI/タイルの所要時間は外部状態に左右されるため、再現性のない秒数を作らず、同じ259方位の新経路実測と往復数で比較した。

## 最終検査

- 回帰テスト: 64/64グループ PASS。
- 全verifyスクリプト: 114/114 PASS。
- 屋上高再発防止テスト: 8/8 PASS。
- ローカルDEM変換重点テスト: 12/12 PASS。
- TypeScript `tsc -b`: PASS。
- Oxlint: PASS。
- Vite本番ビルド: PASS。
- Cloudflare Pages Functions build: PASS。
- spot-search / bearing-profile-download / prewarm Worker dry-run: 3/3 PASS。R2・D1 bindingを保持。
- Android同期・debug APKビルド: PASS。
- ZIP収録前の秘密情報検査、パス検査、重複検査、CRC検査をリリース作成処理で実施する。

証跡は `evidence/gsi-local-five-site-audit-20260928.json`、`evidence/local-dem-server-five-site-audit-20260928.json`、`evidence/local-bearing-profile-benchmark-20260928.json` に保存した。`evidence/`、DEM原本、変換済み巨大データ、`node_modules`、ビルド一時物は配布ZIPへ含めない。

## 本番利用時に必要な外部設定

コードとローカルデータは完成している。本番でEドライブ経路を有効にするには、`docs/LOCAL_DEM_ORIGIN_SETUP.md`に従ってCloudflare Tunnel、Access Service Token、4つのsecretを設定する必要がある。今回は「アップロードしない」という指示に従い、この外部設定とデプロイは行っていない。設定がない状態でも従来のR2・公開GSI経路は動作する。
