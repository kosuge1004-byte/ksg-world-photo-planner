# Phase 5 最終監査・ビルド検証

実施日: 2026-08-06

## 実変更

- `scripts/verify-karney-edge-cases.mjs`
  - 同一点結果の現行契約 (`bearingDefined: false`, `coincident: true`) に追従。
- `scripts/verify-phase5-2-device-cache.mjs`
  - 気象処理の純粋モデル／ブラウザキャッシュ分離後の構成に追従。
- `scripts/verify-workers-kv-writes.mjs`
  - `functions/api/high-precision-session.ts` の意図的なKV書き込み2箇所を許可。
  - 既存の `server/spotSearchJobs.ts` 以外の無制限な書き込み許可にはしていない。
- `package.json`
  - TypeScriptを直接importする検証に Node 22 の `--experimental-strip-types` を追加。
  - 対象: `verify:focal-length-input`, `verify:google-maps-url:live`。

## 成功した検証

- Phase 2 測地・数値精度の静的検証
- Phase 3 DEM/Bicubic検証
- Phase 4 高精度利用制御検証
- Karney同一点契約検証
- 気象デバイスキャッシュ検証
- Workers KV書き込み監査
- 焦点距離入力検証
- Google Maps URLの非ライブ検証
- 最終クリーンアップ監査
- 天体遮蔽理由表示検証
- 高精度利用制御回帰テスト 6件
- ZIP破損検査

## 未完了の検証

### `npm ci`

公式registryを明示して試行したが、この実行環境からのパッケージ取得が完了しなかった。
過去には `youch-core@0.3.3` の取得が内部npmプロキシで404になっている。

### `tsc -b`

依存未取得のため、以下の型定義が存在せずソース型検査前に停止した。

- `vite/client`
- `node`
- `@cloudflare/workers-types`

### `npm run build`

`npm ci`未完了のため未実施。

### 全回帰テスト

高精度利用制御テスト6件は成功。
その後のproduction calculation regressionは `cesium` 未取得で停止した。
これは今回確認できた範囲では計算テストの失敗ではなく、依存不足によるロード失敗。

## リリース判定

**部分完了。リリース可とは判定しない。**

依存取得可能な環境で以下を再実行する必要がある。

```bash
npm ci
npm run test:regression
npx tsc -b
npm run build
npm run lint
```

これらがすべて成功した後にリリース可否を判断すること。
