# 日時・構図候補検索の開始失敗修正

## 症状

- 岐阜城などで日時・構図候補検索を開始すると「検索処理を開始できませんでした」と表示される。
- 以前の版では「検索ジョブが見つかりません」または、ジョブが `queued` のまま進まない場合もあった。

## 原因

通常Functionが検索ジョブを保存した後、同一サイト内の別Background FunctionをHTTPで呼び出す二段構成になっていました。Netlify上で内部呼び出しがBackground Functionへ届かなかった場合、SPAフォールバック等を正常応答と誤認し、保存済みジョブだけが `queued` のまま残る経路がありました。

## 修正

1. `/api/spot-search-start` 自体をBackground Functionに変更しました。
2. 同じFunction内でジョブ保存後に `runSpotSearchJob` を直接実行します。
3. 内部HTTP呼び出しと、分離していたworker Functionを削除しました。
4. サーバー検索を開始できない環境では、同じ検索条件で端末内検索へ自動的に切り替えます。
5. `queued` 停止時の表示から、利用者側の通信不良と断定する文言を削除しました。
6. OpenStreetMap周辺情報の応答が遅い場合は15秒で打ち切り、候補自体を失わず「周辺情報未確認」として検索完了を優先します。

## 配置ファイル

- `netlify/functions/spot-search-start-background.ts`
- `netlify/functions/spot-search-status.ts`
- `netlify/functions/spot-search-finalize.ts`

旧 `spot-search-start.ts` と `spot-search-worker-background.ts` は使用しません。
