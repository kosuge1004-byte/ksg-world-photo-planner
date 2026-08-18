# KSG World Photo Planner 全体コード監査

対象: step5-final-code-review を基準にした全プロジェクト

## 実施範囲

- `src` 全体
- `server` 全体
- `netlify/functions` 全体
- Vite / TypeScript / Oxlint / Netlify設定
- 時間軸横の天体通過日時検索
- 三脚候補検索、保存、地図、標高、タイムゾーン、バックグラウンド検索

## 反映した修正

### サーバーコードを正式なTypeScript検査対象へ追加

従来の `tsc -b` は以下だけを対象としていた。

- `src`
- `vite.config.ts`

そのため以下が正式な型検査対象外だった。

- `server/**/*.ts`
- `netlify/functions/**/*.ts`

`tsconfig.server.json` を追加し、ルート `tsconfig.json` の参照対象へ追加した。
これにより依存関係が揃った環境では `npm run build` 時にクライアント、Vite設定、サーバー、Netlify Functionsをまとめて型検査する。

## 確認結果

- TypeScript / TSX: 78ファイル
- 構文解析エラー: 0件
- `TODO` / `FIXME` / `HACK` / `debugger`: 0件
- `@ts-ignore` / `@ts-expect-error`: 0件
- 今回の日時検索結果選択時に三脚・被写体・焦点距離を変更する処理: 未検出
- 画角内検索から三脚候補探索・構図順位付けを呼ぶ処理: 未検出

## 削除していない未使用候補

以下は現在のimportグラフでは参照されていない。

- `src/components/FocalLengthPanel.tsx`
- `src/components/MobileBottomNav.tsx`
- `src/assets/react.svg`
- `src/assets/vite.svg`
- `src/assets/hero.png`

既存機能や今後のUI復元に使う可能性を否定できないため、今回の全体監査では削除していない。

## 正式検証が残る項目

この実行環境ではnpm依存取得が完了せず、次のパッケージ実体が不足している。

- `vite/client`
- `@types/node`
- `oxlint`
- その他の完全な `node_modules`

したがって次のコマンドの成功確認は、依存関係を取得できる環境で必要。

```bash
npm ci
npm run lint
npm run build
```

`npm run build` は今回追加した `tsconfig.server.json` も検査する。
