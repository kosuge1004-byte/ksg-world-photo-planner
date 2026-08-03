# AstroSight Cloudflare設定手順

## 構成

- Cloudflare Pages: `dist`のReact/Viteアプリを配信
- Pages Functions: `/api/*`の通常API、スポット検索の開始・状態・確定API
- Workers KV `SPOT_SEARCH_JOBS`: 検索要求、進捗、途中結果、最終結果を7日間保存
- Cloudflare Queue `astrosight-spot-search`: 長時間検索をPagesのHTTPリクエストから分離
- Consumer Worker `astrosight-spot-search-consumer`: 既存の検索・計算ロジックを実行

Pages FunctionsのHTTP応答後処理には実行時間の上限があるため、スポット検索本体だけはQueue Consumer Workerで実行します。公開APIパス、リクエスト、レスポンスおよびブラウザー側の状態名は従来どおりです。

## 1. Cloudflareリソースを確認

Cloudflareへログイン済みの環境で実行します。

```powershell
npx.cmd wrangler whoami
npx.cmd wrangler kv namespace list
npx.cmd wrangler pages project list
npx.cmd wrangler queues list
```

使用するリソースは次のとおりです。

- Pages project: `astrosight`
- KV namespace name: `astrosight-cache`
- KV namespace ID: `92197c38d81d48489ef4fdd25b1b9a58`
- KV binding: `SPOT_SEARCH_JOBS`
- Queue: `astrosight-spot-search`

同じ本番KV namespace IDを次の2ファイルに設定します。

- `wrangler.jsonc`
- `wrangler.spot-search.jsonc`

`preview_id`は使用しません。Queueが存在しない場合だけ次を実行します。

```powershell
npx.cmd wrangler queues create astrosight-spot-search
```

## 2. 環境変数とSecrets

Cloudflare Pagesの「Settings > Variables and Secrets」で次を設定します。

- Build variable `VITE_CESIUM_ION_TOKEN`: 必須。Cesiumのクライアント配信用トークン
- Secret `GOOGLE_MAPS_API_KEY`: 推奨。共有URLにPlaces API Place IDや正式座標がない場合、Places API (New)でPlace ID・地点名・住所・座標を補完します。未設定でもURL座標、Maps Feature ID、HTML、地名検索の順で解析します。

Consumer WorkerのWorld Terrainフォールバックにもトークンを設定します。

```powershell
npx.cmd wrangler secret put CESIUM_ION_TOKEN --config wrangler.spot-search.jsonc
```

ローカルでは`.env.local`または`.dev.vars`を使用し、Gitへ追加しないでください。

## 3. Consumer Workerを先にデプロイ

```powershell
npm.cmd run cf:consumer:deploy
```

QueueはConsumerを別Workerとして必要とします。`wrangler.spot-search.jsonc`は1件ずつ処理し、最大3回再試行する設定です。Freeプランでもデプロイできるよう、Paidプラン専用の`cpu_ms`明示設定は使用しません。長時間検索がプラン既定のCPU上限を超える場合はWorkers Paidプランへ変更し、必要なCPU上限をCloudflareの現行制限内で設定してください。

## 4. Cloudflare Pages `astrosight`を設定

GitHubリポジトリ`kosuge1004-byte/ksg-world-photo-planner`をPagesへ接続し、次を設定します。

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`

`wrangler.jsonc`により、Pagesへ次のBindingsが設定されます。

- KV: `SPOT_SEARCH_JOBS`
- Queue producer: `SPOT_SEARCH_QUEUE` → `astrosight-spot-search`

ダッシュボードから設定する場合もBinding名を完全に一致させてください。Binding変更後は再デプロイが必要です。

SPAルーティングはCloudflare Pagesの標準動作を使用します。ルート直下に`404.html`が無い場合、Pagesは未一致パスを自動的に`/`へフォールバックします。`public/_redirects`は確認済みで、循環する`/* /index.html 200`ルールは設定していません。

CLIで直接デプロイする場合:

```powershell
npm.cmd run cf:pages:deploy
```

## 5. geo-tz

`geo-tz`は本来Nodeの`fs`で約26MBの境界データを読みます。Cloudflareビルドでは`prebuild`が同じ`geo-tz` 1970境界データを4MB単位の静的アセットへ分割し、`/api/timezone`は必要部分だけを`env.ASSETS`から読みます。タイムゾーンの境界判定とIANA IDは`geo-tz`と同じデータ・四分木・geobuf判定です。

生成先`public/__astro_internal_geo_tz/`と成果物`dist/`はGit管理対象外です。

## 6. 動作確認

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run build
npx.cmd wrangler pages functions build --outdir .wrangler-pages-bundle
npx.cmd wrangler deploy --dry-run --config wrangler.spot-search.jsonc --outdir .wrangler-consumer-bundle
```

デプロイ後、ブラウザーで次を確認します。

- Cesium 3D表示
- Google Maps共有URL（`maps.app.goo.gl`、`goo.gl/maps`、`google.com/maps`、`maps.google.com`）
- 地名検索、標高、ジオイド、タイムゾーン、OSM
- スポット検索の開始、進捗、`awaiting-3d`、最終確定

## 保存形式

KVレコードは既存API用の`job`に加え、`jobId`、`status`、`progress`、`createdAt`、`updatedAt`、`request`、`partialResult`、`finalResult`、`error`、`expiresAt`を保存します。内部状態は`queued`、`running`、`completed`、`failed`、`cancelled`です。公開APIは既存クライアントとの互換性のため`queued`、`running`、`awaiting-3d`、`complete`、`failed`を維持します。
