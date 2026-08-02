# Cloudflare完全移行 実施結果

実施日: 2026-08-03  
対象: `kosuge1004-byte/ksg-world-photo-planner`  
ベースコミット: `927fa00722d5ef95a0e798f57bcd941d964947db`

## 実装結果

- 通常API 6本をCloudflare Pages Functionsへ移植
- スポット検索の開始・状態・確定APIをPages Functionsへ移植
- 長時間検索をCloudflare Queue Consumer Workerへ移植
- ジョブ保存とDEMデコード済みタイルキャッシュをWorkers KV `SPOT_SEARCH_JOBS`へ移植
- Netlify Background Functions、Netlify Blobs、Netlify Vite pluginを削除
- `geo-tz`の1970境界データと判定方式を維持し、Cloudflare静的アセットから必要な境界データだけを読む互換層を追加
- Google Maps短縮URLのリダイレクト追跡を維持し、郵便番号・住所・地点名形式の最終URLにも対応
- Cloudflare Pages標準のSPAフォールバック、静的レスポンスとAPIレスポンスの`noindex, nofollow`を確認
- React/ViteのUI、スポット検索ロジック、計算ロジックは変更なし

## テスト結果

| 項目 | 結果 |
|---|---|
| `npm ci` | 成功、249 packages、脆弱性0件 |
| `npm run lint` | 成功、エラー0件 |
| `npm test` | 成功、21グループ（Cloudflare追加テスト5件を含む） |
| `npm run build` | 成功、TypeScriptエラー0件、Vite本番ビルド成功 |
| Pages Functions Wrangler build | 成功 |
| Queue Consumer Wrangler dry-run | 成功、upload 1386.09 KiB / gzip 267.75 KiB |
| Wrangler実HTTP `timezone` | `Asia/Tokyo` |
| Wrangler実HTTP Google短縮URL | `35.4339171, 136.782051` |
| Wrangler実HTTP 地名検索 | 岐阜城を取得 |
| Wrangler実HTTP GSI標高 | DEM10B、3.4mを取得 |
| Wrangler実HTTP GSIジオイド | 36.7614mを取得 |
| Wrangler実HTTP OSM | 成功、attribution確認 |
| Wrangler実HTTP 検索開始・状態 | `queued`、進捗0%をKVから取得 |
| SPA未一致パス | HTTP 200 |
| 静的/API検索除外 | `X-Robots-Tag: noindex, nofollow` |

Wranglerの`node:zlib`警告は表示されますが、両Wrangler設定で必要な`nodejs_compat`を有効化済みで、バンドルは成功しています。Viteは既存のメインチャンクが500kBを超える警告を出しますが、ビルドエラーではありません。

## 変更ファイル

### 追加

- `functions/_shared/env.ts`
- `functions/_shared/http.ts`
- `functions/api/resolve-google-maps.ts`
- `functions/api/geocode.ts`
- `functions/api/timezone.ts`
- `functions/api/gsi-elevation.ts`
- `functions/api/gsi-geoid.ts`
- `functions/api/osm-site-context.ts`
- `functions/api/spot-search-start.ts`
- `functions/api/spot-search-status.ts`
- `functions/api/spot-search-finalize.ts`
- `workers/spot-search-consumer.ts`
- `server/cloudflareGeoTz.ts`
- `server/cloudflareRuntime.ts`
- `scripts/prepare-cloudflare-geo-tz-assets.mjs`
- `scripts/verify-cloudflare-migration.mjs`
- `tests/regression/cloudflare-functions.test.mjs`
- `public/_redirects`
- `wrangler.jsonc`
- `wrangler.spot-search.jsonc`
- `CLOUDFLARE_DEPLOYMENT.md`
- `CLOUDFLARE_MIGRATION_RESULT.md`

### 更新

- `.gitignore`
- `README.md`
- `package.json`
- `package-lock.json`
- `public/_headers`
- `vite.config.ts`
- `tsconfig.server.json`
- `server/googleMaps.ts`
- `server/gsiElevation.ts`
- `server/runSpotSearchJob.ts`
- `server/siteContext.ts`
- `server/spotSearchJobs.ts`
- `server/worldTerrain.ts`
- `src/search/spotPresetSearch.ts`（コメントのみ）
- `scripts/run-regression-tests.mjs`
- `scripts/verify-final-cleanup.mjs`
- `scripts/verify-google-maps-url-live.mjs`
- `scripts/verify-search-engine-exclusion.mjs`

### 削除

- `netlify.toml`
- `netlify/functions/*`（11ファイル）
- 未参照の試作UI `FocalLengthPanel.tsx`、`FocalLengthNumberInput.tsx`、`MobileBottomNav.tsx`
- 未参照アセット `hero.png`、`react.svg`、`vite.svg`

未参照ファイルは実行コードからimportされておらず、UI表示や既存機能には影響しません。削除内容はGit履歴から復元できます。

## 未解決・デプロイ前に必要な作業

1. `wrangler.jsonc`と`wrangler.spot-search.jsonc`のKV namespace IDプレースホルダーを実IDへ置換する。
2. Cloudflare Queue `astrosight-spot-search`を作成し、Consumer WorkerをPagesより先にデプロイする。
3. Pagesのビルド変数`VITE_CESIUM_ION_TOKEN`と、Consumer WorkerのSecret `CESIUM_ION_TOKEN`を設定する。
4. 実Cloudflareアカウントへのデプロイは、アカウント・KV・Queue・Secretsが未指定のため未実施。ローカルWrangler実行と両Workerのバンドル/dry-runまで確認済み。
5. 本番デプロイ後にCesium 3Dの目視、実データを使った長時間スポット検索の完走、進捗更新を確認する。
6. Workers KVは結果整合性のため、別リージョンから同時に状態を読むと短時間の反映遅延が起こり得る。強整合性が必要になった場合はDurable Objectsへの置換を検討する。

リソース作成とデプロイの具体的な順序は`CLOUDFLARE_DEPLOYMENT.md`に記載しています。
