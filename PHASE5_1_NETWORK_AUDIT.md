# Phase5-1 通信量・API呼び出し監査

## 実装

- クライアント側の通信診断を `src/network/networkDiagnostics.ts` に集約。
- 外部通信の回数、HTTP状態、所要時間、エラーをカテゴリ別に記録。
- 気象キャッシュについて、ヒット、ミス、同時要求の統合を記録。
- 診断履歴は端末内に最大200件だけ保存し、通信やアプリ動作を妨げない。
- 気象、OSM地点条件、タイムゾーン、ジオコード、Google Maps URL解決、バックグラウンド検索を監査対象にした。

## 現段階で確認した主な通信経路

- `/api/gsi-elevation`
- `/api/gsi-geoid`
- `/api/osm-site-context`
- `/api/timezone`
- `/api/geocode`
- `/api/resolve-google-maps`
- `/api/spot-search-start`
- `/api/spot-search-status`
- `/api/spot-search-finalize`
- Open-Meteo forecast/archive API

## 制約

Phase5-1は計測基盤と監査範囲の確定であり、R2・IndexedDB統合・共有キャッシュ本体は後続フェーズで実装する。
