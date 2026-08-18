# PLATEAU建物の標準モード遮蔽判定への接続（2026-08-07）

## 背景

`PLATEAU_HEIGHT_CORRECTION_REMOVAL_20260806.md`にある通り、全国複合PLATEAUタイルセット
全体へ単一の高さ補正を適用する方式は、地域ごとに異なるジオイド高を正しく扱えないため
撤回された。この経緯により、PLATEAU建物はその後「標準モードの表示専用」に固定され、
遮蔽・見通し・検索計算からは一切切り離されていた。

その結果、標準モードでは「三脚－被写体間の建物遮蔽確認」を有効にしても実際には
何も検証されず（DEMのみで判定）、「見通し確認済みのみ」を有効にすると常に0件になる、
という利用者にとって分かりにくい状態になっていた。

## 実装内容

全国一律の補正を復活させるのではなく、**遮蔽判定でPLATEAU建物と交差した地点だけ**を
対象に、その建物の接地高さをGSI DEMと個別に照合する仕組みを追加した。

- `src/cesium/plateauBuildingVerification.ts`（新規）
  `verifyPlateauBuildingBaseHeight()`：指定した経緯度でPLATEAU建物タイルセットに
  垂直レイを通し、最も低い交点（建物接地部分）を求め、GSI DEM標高と比較する。
  誤差5m以内なら検証済み、それ以外・取得失敗は未検証として扱う。0mフォールバックはしない。

- `src/cesium/celestialOcclusion.ts`
  3D遮蔽情報源を表す`ThirdDimensionSource`（`google-3d` / `plateau-verified` / `none`）を
  新設し、`thirdDimensionSourceForAccuracyMode()`で精度モードとの対応を一本化
  （高精度＝Google 3D、標準＝PLATEAU検証つき）。遮蔽判定の中核関数
  `calculatePhotorealisticMeshIntersection`は、PLATEAU経路のときだけ交差した
  建物ごとの高さ検証を行い、検証NGなら「遮蔽あり」と断定せず未確認のまま返す。

- `src/App.tsx`
  検索の被写体間遮蔽確認（`completeBackgroundSpotSearch`）で、標準モードを問答無用で
  DEMのみ・未確認としていた早期リターンを削除し、高精度モードと同じ検証ループへ合流。
  プレビュー画面の天体遮蔽確認（`evaluateCelestialLineOfSight`の2箇所の呼び出し）も
  同様に対応。

- `src/components/SpotSearchScreen.tsx`
  検索条件UIの説明文と、結果一覧の3D確認状態表示を実態に合わせて更新
  （どちらの情報源で確認したかを明示）。

## 検証状況

- `npx tsc -b`：エラー0件
- `npm run test:regression`：27グループ全PASS
- 実機でのCesium 3Dレンダリング挙動（実際のPLATEAU建物との交差判定の精度）は
  この開発環境では検証できていない。実機での動作確認が別途必要。

## 変更していないもの

- 高精度モードのGoogle Photorealistic 3D Tiles経路は変更なし（追加の高さ検証も行わない）。
- 全国一律の高さ補正は復活させていない。
