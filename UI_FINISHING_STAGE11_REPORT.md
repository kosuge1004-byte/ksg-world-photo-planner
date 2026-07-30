# 修正11 完了報告

## 修正内容

- 分割2の遮蔽状態区分 `checking / dem-only / dem-and-google-3d / failed` を使い、内部状態を利用者向け文言へ変換する共通処理を追加しました。
- 地平線下、山・地形、建物・3Dデータ、判定中、判定不能を区別しました。
- `checking` と `failed` を遮蔽確定より優先して判定し、古い理由値が残っても「隠れている」と誤表示しないようにしました。
- DEMで地形遮蔽が確定している場合は、Google 3D確認前でも「山や地形に隠れています」と表示します。
- DEM確認後にGoogle 3Dを待っている状態と、Google 3Dを取得できなかった状態を分けました。
- プレビュー左下へ小さなステータスを追加し、確定した遮蔽理由は天体ごと、判定中・判定不能は複数天体を1行へまとめて表示します。
- 全天体が表示可能な場合、未配置の場合、表示設定OFFの場合は不要なステータスを表示しません。
- ステータスは操作を受け取らず、太陽・月・天の川の描画やプレビュー操作を妨げません。

## 表示対応

| 内部状態 | 内部理由 | 表示 |
|---|---|---|
| `checking` | 任意 | 遮蔽を確認中です |
| `failed` | 任意 | 遮蔽を確認できません |
| `dem-and-google-3d` | `below-horizon` | 地平線の下です |
| `dem-only` / `dem-and-google-3d` | `terrain` | 山や地形に隠れています |
| `dem-and-google-3d` | `building-or-surface` | 建物・3Dデータに隠れています |
| `dem-only` | `unverified`・失敗情報なし | 建物の遮蔽を確認中です |
| `dem-only` | `unverified`・失敗情報あり | 建物の遮蔽を確認できません |
| `dem-and-google-3d` | `visible` | 表示なし |

## 対象ファイル

- `src/celestial/occlusionReason.ts`
- `src/components/CelestialOcclusionStatus.tsx`
- `src/App.tsx`
- `src/App.css`
- `scripts/verify-occlusion-reasons.mjs`
- `package.json`

## 確認条件ごとの結果

- 遮蔽理由が実際の判定と一致する: 満たした
- 未検証状態を遮蔽確定と表示しない: 満たした
- TypeScriptエラーがない: 満たした
- ビルドが成功する: 満たした

## 確認結果

- `npm run verify:occlusion-reasons`: 合格
- `npm run verify:occlusion-state`: 合格
- 修正08・10および分割1・分割2の既存回帰検証: 合格
- `npm run lint`: 合格
- `npm run build`: 合格
- `npm run android:sync`: 合格
- `npm run verify:android`: 合格
- ブラウザで通常時に不要な遮蔽ステータスが出ないことを確認: 合格
- 配置・可読性・非操作性は専用検証スクリプトとCSS定義で確認: 合格

## 未解決事項

- 実際の山、建物、地平線下の各地点で、実Android端末・iPhone端末を使った表示確認は未実施です。
- 500kBを超えるJavaScriptチャンクの既存ビルド警告がありますが、ビルドは成功しています。
