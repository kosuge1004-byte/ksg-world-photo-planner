# PLATEAU高度・表示補正

## 変更
- 標準モードのPLATEAU建物を、国土地理院ジオイドAPIで取得した地点別ジオイド高だけ下方向へ補正。
- API取得失敗時のみ表示用フォールバック35mを使用。
- `Cesium3DTileStyle`で明るいグレー・不透明度0.94を指定し、LOD1の黒潰れを抑制。
- 建物の追加前に補正とスタイルを適用し、未補正状態の瞬間表示を防止。
- `maximumScreenSpaceError=8`、`skipLevelOfDetail=true`、`preferLeaves=true`で見た目を改善。
- 国土地理院背景地図・地球面を維持し、深度判定とライティングを有効化。

## 非変更
PLATEAUは表示専用。標高、遮蔽、三脚候補、画角、天体検索などの計算経路には接続していない。

## 制約
全国複合データはLOD1のため、建物形状自体は箱型である。高度・色・地面との整合は改善できるが、Google Photorealistic 3D Tiles相当の外観にはならない。
