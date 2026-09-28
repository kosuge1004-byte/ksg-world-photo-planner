# 登録スポット事前計算・最終検査報告（2026-09-29）

## 実装結果

登録済みスポットのうち、指定どおり山岳は富士山だけを対象とし、城、建物、塔、タワー、寺社、自然景観、テーマパーク、観覧車を含む200地点について、10 km・360方位の高精度地形プロファイルを事前計算した。2026-09-29に「岩屋観世音菩薩像（愛知県）」「王ヶ頭ホテル（長野県）」「美しの塔（長野県）」「上陸大師像（愛知県）」「日出の石門（愛知県）」「夫婦岩（三重県）」の正式名称・分類を反映した。

計算値は従来と同じDEM優先順位、補間、JPGEO2024ジオイド補正を通して生成している。三脚候補点の座標、距離間隔、標高値を簡略化していない。事前計算が存在しない座標や10 km以外の要求では、従来の正確な動的計算へ戻る。

事前計算データは次に保存されている。

`E:\AstroSight-GSI-data-20260926\dem\r2-ready\precomputed-bearing-profile-v1`

アプリのソースZIPにはこの外部データを重複収録しない。ローカルDEMサーバーは上記ディレクトリの固定マニフェストだけを読み、任意パスの参照、一覧取得、書き込みは提供しない。

## 容量と全件監査

- 登録対象: 200地点
- ファイル: 200個 + `manifest.json`
- 方位: 各360方位
- 地形点: 合計25,344,000点
- gzip合計: 220,834,430 bytes（約210.6 MiB）
- 展開後合計: 667,692,511 bytes（約636.8 MiB）
- 1ファイル: 994,766～1,162,731 bytes
- マニフェストSHA-256: `817d60d749b58a972bc8fda7bdf8690cf5caae06b665f9e0b0dd012d3eccbb69`

`npm run local-dem:audit-precomputed` により、登録対象との完全一致、全ファイルのSHA-256、gzip展開、全360方位、応答形式、孤立ファイルがないことを検査し、PASSした。

## 速度実測

東京スカイツリー、10 km、259方位、91,168地形点でローカル原点を実測した。

- 259方位一括、初回: 100.0 ms
- 259方位一括、メモリーキャッシュ後: 29.4 ms
- 実アプリと同じ32方位単位の9リクエスト合計: 59.1 ms
- 応答データ量: 約2.36 MiB
- 従来の動的259方位計測: 約137.2秒

59.1 msは地形プロファイルをローカル原点から受け取る部分の実測である。端末のIndexedDB書き込み、水面・OSM周辺情報、Cloudflare Tunnelの実通信時間は別に加わる。

実測中に、259方位応答が従来のCloudflare側2 MiB受信上限を超える問題を検出した。上限を8 MiBへ修正し、2 MiBを超える259方位レスポンスが1回で通る回帰テストを追加した。通常のアプリ処理は無料枠の外部サブリクエスト上限を守るため、最大32方位ずつに分割する。

## 主な変更

- `server/precomputedBearingProfiles.ts`: 事前計算形式、厳密検証、要求方位の抽出
- `tools/local-dem-server/readOnlyBearingProfileStore.ts`: SHA-256確認付き読み取り専用ストア
- `tools/local-dem-server/app.ts`: 認証済み固定エンドポイント
- `tools/local-dem-server/server.ts`: 起動時マニフェスト読込
- `server/localDemGateway.ts`: Cloudflareからローカル原点を優先し、失敗時だけ従来処理へ戻す経路
- `server/bearingProfileBatch.ts`: 事前計算優先の全方位処理
- `src/cache/bearingProfileBatchClient.ts`: 事前計算フラグの保持
- `src/cache/tripodBearingProfileManager.ts`: 事前計算時の重複DEMタイル取得を省略
- `scripts/precompute-landmark-bearing-profiles.mjs`: 中断再開可能な全地点生成
- `scripts/audit-precomputed-landmark-profiles.mjs`: 全件完全性監査
- `scripts/benchmark-precomputed-profile-origin.mjs`: 259方位実測
- `docs/LOCAL_DEM_ORIGIN_SETUP.md`: 起動、生成、配置、セキュリティ手順

R2の既存機能は停止していない。R2と公開GSIタイルは、ローカルデータで解決できない場合の既存フォールバックとして残している。今回、新たな有料サービスや有料ストレージは作成していない。

## 最終検査

- 回帰テスト: 64グループ PASS
- 独立verifyスクリプト: 114/114 PASS
- TypeScript + Vite production build: PASS
- lint: エラー0（既存警告17件）
- ローカルDEM原点の認証、固定経路、パストラバーサル防止、フォールバック順序: PASS
- 登録スポット事前計算データ全件監査: PASS
- 被写体ピンの頂上・地形分類回帰テスト: 10/10 PASS
- 高塔上限検証（東京タワー333 m、東京スカイツリー634 mを含む）: PASS

GitHub、Cloudflare、R2へのアップロードは行っていない。
