# 三脚候補周辺データ ダウンロード0°停止対策 (2026-09-08)

## 実コードで確認した原因
`backfillBearingProfiles()` は各方位について、10m地形プロファイル取得の完了後に1m高精度DEM取得を行い、その方位が完了して初めて `completedSteps` を増やす。したがって最初の0°処理が長引くとUIは `0 / 360` のままになる。

GSI HTTP要求自体には30秒タイムアウトがあるが、1方位の地形取得ステージ全体には上限時間が無く、GSI後段のfallback等を含めた処理が長引いた場合に0°表示が継続する経路があった。

## 修正
- 10m地形プロファイル取得と1m高精度DEM取得を、それぞれ45秒の方位ステージ上限で保護。
- 親のユーザー中断AbortSignalを子ステージへ伝播。
- タイムアウトした方位は既存の失敗処理に流し、次の方位へ進める。
- UIに `地形プロファイル取得中` / `高精度DEM保存中` を表示し、0°の内部工程が見えるようにした。
- 三脚候補点の計算アルゴリズム、DEM詳細度（10m粗探索 / 1m高精度保存）、座標列は変更していない。

## 検証
- `verify-bearing-profile-download-stall-fix-20260908.mjs`: 8/8 PASS
- `npx tsc --noEmit`: PASS
- downloaded spot high precision: 7/7 PASS
- downloaded data audit fixes: 12/12 PASS
- downloaded-data-management-detail: 16/16 PASS
- shared DEM refs: 9/9 PASS
- tripod timeout elimination: 15/15 PASS

## フルビルド
`npm run build` はコードコンパイル前の prebuild で `geo-tz` パッケージ欠落により停止。今回の変更由来のTypeScriptエラーではない。`npx tsc --noEmit` はPASS。
