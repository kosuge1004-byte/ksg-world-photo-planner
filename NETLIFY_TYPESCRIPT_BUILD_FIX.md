# Netlify TypeScript build error fixes

修正対象: 2026-07-25 に提示された Netlify build log の7件

## 修正内容

1. `src/App.tsx`
   - `locateSubjectFromSpotScreen` の `onProgress` 型を `(message: string, percent: number) => void` に統一。
   - 進捗通知を `onProgress("被写体の位置を検索しています…", 0)` に修正。

2. `server/gsiElevation.ts`
   - 永続Blobストアへ渡すシリアライズ値を `Uint8Array` ではなく `ArrayBuffer` に変更。
   - 未使用の旧単点取得関数 `lookupOneElevation` を削除。

3. `server/lruPromiseCache.ts`
   - TypeScript 6 の `erasableSyntaxOnly` で許可されない constructor parameter property を廃止。
   - `options` を通常のクラスプロパティとして宣言し、constructor内で代入。

## 確認

- 上記ログに表示された TS2322 / TS2345 / TS6133 / TS1294 の原因箇所を実ファイルで修正済み。
- ZIP整合性検査済み。
- ローカルの同梱 `node_modules` は不完全で `vite/client` と `@types/node` が欠けているため、この環境では完全ビルドまで実行できなかった。Netlifyでは通常 `npm install` 後にビルドされるため、再デプロイで次のエラー有無を確認する。
