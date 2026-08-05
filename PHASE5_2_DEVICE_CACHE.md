# Phase5-2 端末キャッシュ統合

- 共通の端末キャッシュ層 `src/cache/deviceCache.ts` を追加。
- メモリLRUとIndexedDBを同一APIで利用。
- API種別ごとのTTL、最大件数、メモリ上限を `cachePolicies.ts` に集約。
- 期限切れとLRU超過レコードを自動削除。
- 旧気象localStorageキャッシュを初回読込時にIndexedDBへ移行。
- 気象予報・気候値キャッシュを共通層へ移行。
- IndexedDB非対応・プライベートモードではメモリキャッシュのみで継続。

DEM・ジオイドは既存IndexedDBキャッシュを維持し、Phase5-3以降で同時要求共有と共通キー規則を接続する。
