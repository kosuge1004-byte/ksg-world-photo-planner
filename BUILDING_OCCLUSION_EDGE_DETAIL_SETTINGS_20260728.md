# ②建物3D遮蔽の詳細判定設定（縁サンプリング）

## 変更内容

これまで②（Photorealistic 3Dによる建物遮蔽の最終確認）は、太陽・月・天の川などの
**中心1点**へレイを飛ばすだけの判定でした。そのため「満月の下半分だけ建物にかかる」
のような部分遮蔽は表現できず、常に見える／遮蔽ありの二値でした。

今回、②に限定して、太陽・月の視直径（円盤の大きさ）を考慮した縁サンプリングを追加し、
ハンバーガーメニュー > 精度設定から詳細設定できるようにしました。①（地形DEMによる見通し
判定）は対象外で、従来どおり中心1点判定のままです。

## 追加設定（ハンバーガーメニュー > 精度設定）

- **太陽・月の視直径を考慮した縁判定を有効にする**（初期値：OFF）
  - OFF: 従来どおり中心1点だけで判定（速い）
  - ON: 中心＋円盤の縁を追加サンプリングして判定
- **縁のサンプル点数**：4点／8点（初期値）／12点
- **「遮蔽物あり」と判定する遮蔽割合**：0〜100%（初期値：50%）
  - サンプル点（中心＋縁）のうち遮蔽された割合がこの値以上のとき「遮蔽物あり」と判定
- 初期値に戻すボタンあり
- 天の川・北極星は点光源として扱うため、視直径0＝この詳細判定の対象外（従来どおり中心判定）

## 仕組み

- `src/cesium/celestial.ts`
  - `celestialAngularDiameterDegrees()` を追加。太陽・月の視直径（度）を返す
    （既存の `apparentDisc` と同じ計算式を軽量化して再利用）。
- `src/cesium/celestialOcclusion.ts`
  - `evaluatePhotorealisticMeshLineOfSight()` に `discDetail` 引数を追加。
  - 視直径と設定から、中心＋縁の複数点（方位は cos(仰角) 補正込み）を生成し、
    それぞれへ独立にレイキャスト。
  - 遮蔽サンプル数の割合が設定した閾値以上なら「遮蔽物あり」、未満なら「見通し確認済み」。
  - 詳細判定OFF時・視直径0（天の川・北極星）のときはサンプル点が1つ（中心のみ）になり、
    従来と完全に同じ挙動（1点でも遮蔽なら遮蔽扱い）に自動的にフォールバックする。
- `src/types/precision.ts` / `src/App.tsx`
  - `buildingOcclusionDetailSettings` を精度設定へ追加し、localStorageへ保存（旧設定からの
    移行処理付き）。
- `src/types/search.ts`
  - `SpotSearchCriteria.buildingOcclusionDetailSettings` を追加（検索画面 → バックグラウンド
    ジョブへ設定を引き継ぐ）。
  - `SpotPresetResult.buildingObstructedFractionPercent`（任意）を追加。
- `src/components/SpotSearchScreen.tsx`
  - 結果一覧・詳細画面に、詳細判定を使った場合の遮蔽割合（%）を表示。

## 注意点

- サンプル点が増えるほど、候補1件あたりのレイキャスト回数（Cesium
  `drillPickFromRayMostDetailed`）が増えるため、②全体の検索時間が伸びます。
- サーバー側（`validSpotSearchJobInput`）は `criteria` の中身を深く検証していないため、
  新しいフィールドを追加してもジョブ保存・起動には影響しません（既存の
  `subjectObstructionExclusionMeters` と同じ扱いです）。

## 未確認事項

- 依存パッケージ（vite/client, @types/node 等の実体）がこの環境に無いため、
  プロジェクト全体のローカルビルド・型検査は未実施。手動でのブレース対応確認、
  重複宣言の有無、既存パターンとの整合性確認は行っています。
