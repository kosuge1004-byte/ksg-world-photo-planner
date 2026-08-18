# AstroSight

天体撮影プランニング用のReact + Vite + Cesium + Capacitorアプリです。Web版のAPIとバックグラウンド検索はCloudflare Pages Functions、Workers KV、Cloudflare Queuesで動作します。

## ローカル開発

1. `.env.local`に`VITE_CESIUM_ION_TOKEN`を設定します。
2. 次のコマンドを実行します。

```powershell
npm.cmd ci
npm.cmd run dev
```

`npm run dev`では、ViteのローカルAPIがPages Functionsと同じ公開APIパスを提供します。

## 検証

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run verify:cloudflare
```

Cloudflareのリソース作成、Bindings、デプロイ順序については[CLOUDFLARE_DEPLOYMENT.md](./CLOUDFLARE_DEPLOYMENT.md)を参照してください。

## 秘密情報

`.env`、`.env.local`、`.dev.vars*`、`node_modules`、`dist`、Wranglerのローカル状態はGitへ含めません。`VITE_`で始まる値はブラウザーへ公開されるため、秘密鍵には使用しないでください。
