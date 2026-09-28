# 国土地理院 GML DEM のローカル R2 統合

## 実装方針

`server/gsiElevation.ts` の既存の精度優先順位は変更しない。

1. DEM1A
2. DEM5A
3. DEM5B / DEM5C
4. DEM10B

各段階で `gsi-local-dem-v1/` の R2 アセットを先に調べ、該当グリッドから値を得られた点だけを解決済みにする。次の場合は、その点だけを従来の `cyberjapandata.gsi.go.jp` PNG タイル取得へ戻す。

- ローカル DEM の manifest が未配置
- 対象メッシュのアセットが未配置
- R2 読み取り失敗またはアセット破損
- GML の NoData

バイリニアまたは 4×4 Constrained Bicubic の近傍が GML メッシュ境界をまたぐ場合は、隣接メッシュのローカルアセットを追加で読み、真の隣接値を使う。隣接アセットが欠ける場合も端値を複製せず、既存タイルへ戻す。

ローカルアセットが1つもない環境では `gsi-local-dem-v1/manifest.json` の不存在を短時間キャッシュし、DEMソースごとの不要な R2 GET を行わない。manifest を含むアセットを R2 に配置した環境だけでローカル経路が有効になる。今回、R2 へのアップロードは行っていない。

## バイナリ形式

前処理は GML の実値を次の形式へ変換する。

- R2 キー: `gsi-local-dem-v1/<DEM種別>/<メッシュコード>.bin.gz`
- 1m / 5m: 3次メッシュ（8桁）単位
- 10m: 2次メッシュ（6桁）単位
- 値の順序: `+x-y`（西から東、その後北から南）
- 高さ: signed int32、cm単位
- NoData: `-2147483648`
- 圧縮: gzip
- bbox、幅、高さ、緯度・経度格子間隔を80 byteのヘッダーに保存

cm整数は現行の GSI PNG タイルデコーダと同じ単位であり、GMLの通常の0.01 m（DEM10は主に0.1 m）精度を失わない。`-9999` は分類文字列に依存せず数値で NoData に変換し、0 m は有効値のまま保持する。

Worker のローカル GML キャッシュは 32 MiB の LRU 上限、R2 読み取りは最大2並列にした。既存の公開 PNG デコードキャッシュも枚数固定ではなく24 MiBのバイト上限に変更した。1回のリクエスト内の公開 PNG はベース8タイルずつ処理し、最大2,048点が日本各地へ分散していても全タイルを同時保持しない。

R2キーから期待されるJISメッシュ範囲と、バイナリヘッダー内のbboxを読み取り時に照合する。別メッシュの内容や壊れたアセットを同じキーへ置いても採用せず、公開タイルへ戻る。

## 前処理

メッシュ別 ZIP、地域別の外側 ZIP（内包 ZIP あり）、展開済み XML を処理できる。入力 ZIP 自体は変更・展開しない。

```powershell
npm run prepare:gsi-dem-r2 -- `
  --input E:\AstroSight-GSI-data-20260926\dem\spot-search-10km `
  --output E:\AstroSight-GSI-data-20260926\dem\r2-ready
```

展開済み XML のファイル名だけでは `DEM5A` などの枝番を判断できない場合、明示する。通常は圧縮ファイルを保持したまま外側の地方区分ZIPを直接入力できる。

```powershell
npm run prepare:gsi-dem-r2 -- `
  --input E:\AstroSight-GSI-data-20260926\dem\official-archive\DEM1\chubu\FG-GML-chubu-DEM1-20260616-Z023.zip `
  --output E:\AstroSight-GSI-data-20260926\dem\r2-ready
```

出力先は R2 キーと同じディレクトリ構造になる。再実行時は `asset-inventory.jsonl` と処理中の journal を読み、既存アセットを保持したまま manifest を更新する。アセットを書いた直後に journal へ記録するため、全国変換が途中停止しても、再開時は既存 gzip の SHA-256 を検査して再圧縮を省略できる。同じキーに異なる元グリッドが見つかった場合は停止する。意図して版を置き換える場合だけ `--replace` を指定する。

`manifest.json` には種別ごとのアセット数、gzip後と展開後の総容量が記録される。その値を使って、全ランドマーク分を変換した後に R2 必要容量を確定できる。

## 実データ検査

前処理を次の実ファイルで確認した。

| 入力 | 出力 | gzip後 | 展開後 |
|---|---|---:|---:|
| `FG-GML-533805-DEM10B-20161001.zip` | 1アセット | 1,953,634 B | 3,375,080 B |
| `FG-GML-chubu-DEM1-20260616-Z023.zip` | 136 DEM1Aアセット | 131,249,574 B | 459,010,880 B |

ZIPは中央ディレクトリから読み、各エントリの展開サイズとCRC32を検査する。XML宣言を先に検査し、新しいUTF-8と旧DEM5のShift_JISを置換文字なしで厳格に読む。`lowerCorner`, `upperCorner`, `low`, `high`, `startPoint`, `sequenceRule`, `tupleList` とJISメッシュ範囲を検証した。実 ZIP を展開せずに変換できた。疎な旧DEMは`startPoint`前後の未記録セルをNoDataとして保持し、記録点数と暗黙NoData数をインベントリへ残す。

## 公開 PNG タイルとの数値差

配布 GML と公開 PNG タイルは、更新版または生成時の再標本化が同一とは限らない。実際の `53341400 / DEM5A` 内の5点を同じバイリニア方式で比較すると、次の差が出た。

| GMLローカル (m) | 現行公開PNG (m) | GML - PNG (m) |
|---:|---:|---:|
| 614.975 | 612.5086 | +2.4664 |
| 574.100 | 575.7274 | -1.6274 |
| 594.1188 | 592.2311 | +1.8877 |
| 548.6960 | 547.6851 | +1.0109 |
| 436.5640 | 433.7457 | +2.8183 |

これはバイナリ化の丸め誤差ではなく、入力値そのものの差である。そのため「新しい配布 GML のネイティブ値」と「現行公開 PNG の値」を数 cm 以内で一致させることはできない。ローカル GML は元の cm 値と解像度を保持するが、既存結果との完全な後方一致が必要なら、同じ公開 PNG を事前取得して既存の `gsi-decoded-dem-v2/` 形式へ格納する必要がある。

本実装は manifest が R2 に無い限り有効化されない。したがって、全国・ランドマーク5地点・沿岸部の比較結果を確認してから manifest を配置でき、検証前に本番の三脚候補結果が切り替わることはない。

スポット検索の実カタログ284件を基準に10 km圏を集計すると、1,283個の2次メッシュ、4,405配布ファイル、推定134.431 GiBになった。旧サーバープリウォーム一覧は観覧車6件を欠いていたため、マニフェスト生成元を `src/data/japanLandmarks.ts` へ変更し、284/284件の包含検査を追加した。全国275 ZIPにはこの範囲もすべて含まれる。

変換済み中部DEM1をファイルベースR2として使い、外部 `fetch` を失敗させる条件で実処理を計測した。緯度36.458333°・経度137.4375°、1 km、実アプリと同じ259方位・14,245点で、初回766.103 ms、メモリ再利用127.745 ms、R2相当読み取り7件、外部通信0件、失敗方位0件だった。64方位ずつ送るクライアント設定ではHTTP 5回に相当する。

## 検査

`tests/regression/gsi-local-dem.test.mjs` で次を固定した。

- JIS 2次・3次メッシュコード
- gzipを含む cm / NoData の完全な往復
- 平面グリッドのバイリニア / Constrained Bicubic
- 隣接GMLアセットが欠けるメッシュ境界での既存経路フォールバック
- 隣接GMLアセットがあるメッシュ境界で、外部通信なしに真の近傍値を使うこと
- `+x-y`、セル中心、数値 `-9999` の解析
- R2 にローカルアセットがある場合、外部 `fetch` を一度も呼ばず結果を返すこと

確認コマンド:

```powershell
node --import ./scripts/register-typescript-source-loader.mjs --test ./tests/regression/gsi-local-dem.test.mjs
npx tsc -p tsconfig.server.json --noEmit
npx oxlint server/gsiLocalDem.ts server/gsiElevation.ts tests/regression/gsi-local-dem.test.mjs scripts/prepare-gsi-dem-r2-assets.mjs
```

上記はいずれも PASS した。
