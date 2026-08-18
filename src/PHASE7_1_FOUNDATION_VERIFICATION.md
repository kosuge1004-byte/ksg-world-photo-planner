# Phase7-1 基礎品質検証

## 追加内容

- `npm run verify:phase7-1` を追加。
- TypeScript、oxlint、回帰テスト、本番ビルドを同一手順で順番に検証。
- 必須依存パッケージが欠けている場合は、ソース不良と誤判定せず事前条件エラー（終了コード2）として停止。
- 実行結果を `PHASE7_1_VERIFICATION_RESULT.json` に保存。

## この環境での実行結果

この作業環境では `npm ci` が内部npmミラー上の `youch-core-0.3.3.tgz` 404で停止したため、依存関係を完全には復元できなかった。
その結果、TypeScript・lint・回帰テスト・Viteビルドの最終合否は未確定。確認された失敗は、`geo-tz`、`typescript`、`vite/client`、`@types/node`、`@cloudflare/workers-types` などの未配置による事前条件不足であり、アプリのTypeScriptソースエラーを示すものではない。

## 再検証手順

```bash
npm ci
npm run verify:phase7-1
```

`PHASE7_1_VERIFICATION_RESULT.json` の全項目が終了コード0になった場合にPhase7-1完了と判定する。
