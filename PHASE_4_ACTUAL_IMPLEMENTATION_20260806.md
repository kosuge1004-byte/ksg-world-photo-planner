# Phase 4 実装記録

## 実変更

- `server/highPrecisionUsagePolicy.ts`を追加し、800通知・850停止の境界判定を純粋関数化。
- `HIGH_PRECISION_ENABLED=false`による緊急停止を追加。
- 850件目は許可し、850件到達後の新規セッションから停止する仕様を固定。
- `America/Los_Angeles`基準の月次キーを共通化。
- 高精度停止時にUIを標準モードへ自動切替。
- `SPOT_SEARCH_JOBS` KVは既存のまま維持。
- 境界値・緊急停止・月跨ぎの回帰テストを追加。

## 実行結果

- `node --experimental-strip-types --test tests/regression/high-precision-usage-policy.test.mjs`: PASS（6件）
- `node scripts/verify-phase4-high-precision-usage.mjs`: PASS
- `node --experimental-strip-types --check server/highPrecisionUsagePolicy.ts`: PASS
- `node --experimental-strip-types --check functions/api/high-precision-session.ts`: PASS

## 未検証

- `npm ci`、`tsc -b`、`npm run build`は依存パッケージ取得環境の問題により未実行。
- KVは結果整合性のため、多数の完全同時アクセスでは850を超える可能性を理論上排除できない。現行の150件余裕を維持し、厳密な原子カウンターが必要になった段階でDurable ObjectsまたはD1を高精度カウンター専用に追加する。
