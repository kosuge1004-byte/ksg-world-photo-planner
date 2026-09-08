# Phase7-2 スポット検索「一時停止→再開」監査解決記録 — 2026-09-08

## 対象

- 唯一の基準: `AstroSight-full-audit-continued-2-20260908.zip`
- 元ZIP SHA-256: `0E7C6310505A6878714769003F11C948A807360599CF35414920DC5ADC3DA8D7`
- 未解決項目: `scripts/verify-phase7-2-search.mjs` が `SpotSearchScreen` の `onResumeSearch` / `isPaused` を要求する点

## 結論

この非ゼロ終了はスポット検索実装の回帰ではなく、意図的に廃止された旧「日時・構図候補検索」UIの一時停止・再開契約が `verify-phase7-2-search.mjs` にだけ残った stale contract である。

実装へ `onResumeSearch` / `isPaused` を復元すると、現行の場所専用スポット検索仕様と矛盾するため、アプリ実装は変更していない。検証スクリプトだけを現行仕様へ合わせた。

## 根拠

1. `UI-lightweight-completion-report.md` 38行目は、スポット検索内の日時・構図候補UIを前提とする stale contract を新仕様へ更新したと明記している。
2. 同報告79〜81行目は「日時・構図候補も検索」UIと候補結果を削除し、精度系の既存計算実装は壊さずUIから到達不能にしたと明記している。
3. `src/components/SpotSearchScreen.tsx` 42〜45行目および342行目は、この画面を被写体／三脚の場所検索専用と定義している。公開コールバックは `onLocatePin` であり、`onResumeSearch` / `isPaused` は存在しない。
4. `src/App.tsx` 3782〜3785行目は旧日時・構図検索の計算実装を精度監査用に温存しつつUIから完全に切り離す方針を明記し、5728〜5732行目は `SpotSearchScreen` に `onLocatePin={locatePinFromSpotScreen}` だけを接続している。
5. `scripts/verify-search-generation.mjs` 22〜35行目と `scripts/verify-search-progress.mjs` 83〜87行目は、すでに場所専用UIとAbortControllerによる中断を現行契約として検証している。

## 変更

- `scripts/verify-phase7-2-search.mjs`
  - 旧 `onResumeSearch` / `isPaused` 存在要求を削除。
  - `onLocatePin`、場所専用UI文言、`App`からの `locatePinFromSpotScreen` 接続を検証。
  - 廃止済み `onResumeSearch` / `isPaused` が再導入されていないことを検証。
- 本番コード (`src/**`, `server/**`, `functions/**`, `workers/**`) は変更なし。
- 三脚候補のECEF方式、候補地点別気象再解決、最終高度・方位収束判定、地点別ジオイド処理、河川の最寄り陸地標高処理は変更なし。

## 検証結果

- `node scripts/verify-phase7-2-search.mjs`: PASS
- `node scripts/verify-search-progress.mjs`: PASS
- `node scripts/verify-search-generation.mjs`: PASS
- `node scripts/verify-phase6-4-search-speed.mjs`: PASS
- `npx tsc --noEmit`: PASS
- `npm test`: 非ゼロ終了。検索関連を含む前段はPASSし、今回と無関係な `verify-final-cleanup.mjs` が未参照の `src/components/Map2DInteractionLayer.tsx` を検出して停止。
- `npm run build`: 非ゼロ終了。`tsc -b` が元ZIP由来の既存TypeScriptエラー（`GroundPoint.label` / `SubjectRecord.height` 不足、未使用変数、IndexedDB型、`IdbTransaction.abort`）を検出し、Vite工程には到達しなかった。

ビルドエラー解消や未参照ファイル削除は本監査の検索契約修正とは別の変更になるため、根拠なく対象を広げていない。
