# スポット検索の焦点距離入力修正

## 原因
スポット検索画面の `criteria.focalLengthMm` ではなく、メイン画面の `cameraSettings.focalLengthMm` が三脚候補計算に渡されていました。

そのため、検索画面で24mmを指定しても、メイン画面が374mmなどの場合は374mmの狭い画角条件で検索され、候補が0件になり得ました。

## 修正
`server/runSpotSearchJob.ts` で検索用カメラ設定を組み立てる際、焦点距離は必ず `input.criteria.focalLengthMm` を使用するよう変更しました。カメラ高は従来設定を維持します。
