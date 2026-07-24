# スポット検索 0%停止修正

- `/api/spot-search-start` 自体をNetlify Background Function化
- 通常Functionから別Background Functionをfetchする二段起動を廃止
- 同一Background Function内で `runSpotSearchJob` を直接実行
- queuedが30秒続く場合に起動待ち表示
- queuedが90秒続く場合は無限待機せずエラー表示
