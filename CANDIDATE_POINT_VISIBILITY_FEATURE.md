# 三脚候補点・遮蔽判定機能

赤い三脚候補線上の点について、DEM地形とPLATEAU建物の両方で被写体までの見通しを確認する独立機能です。
表示するのは両方で遮蔽なしを確認できた緑の点だけです。PLATEAU未収録・通信不能など建物判定が未確認の点は表示しません。

## 一時的に無効化

`src/visibility/candidatePointVisibilityFeature.ts` の
`CANDIDATE_POINT_VISIBILITY_ENABLED` を `false` にします。ボタン、通信、2D/3D描画がすべて停止します。既存の三脚候補線・三脚候補点計算は変更されません。

## 構成

- クライアント計算: `src/visibility/candidatePointVisibility.ts`
- UI切替: `src/visibility/candidatePointVisibilityFeature.ts`
- 2D表示: `src/components/Map2DOverlay.tsx`
- 3D表示: `src/cesium/candidatePointVisibilityEntities.ts`
- Pages API: `functions/api/candidate-point-visibility.ts`
- ローカルDEM接続: `server/localDemGateway.ts`
- PLATEAU判定: `tools/local-dem-server/plateauLineOfSight.ts` と `plateauBuildingStore.ts`
- API型: `src/types/candidatePointVisibility.ts`

被写体建物は `dataset + buildingId` の完全一致でのみ除外します。近隣建物を範囲で除外しません。
