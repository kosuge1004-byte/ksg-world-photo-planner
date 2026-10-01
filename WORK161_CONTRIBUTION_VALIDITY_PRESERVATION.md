# Work161 — Final stack validity/contribution preservation

Status: WIP, validated within available environment.

## Implemented
- Milky Way rejection stacking now persists the exact per-channel survivor count emitted by `TiledKappaSigmaCombiner` for every output pixel/channel.
- Counts are written transactionally to a `LinearContributionTileStore` alongside the RGB store.
- A numeric RGB value of zero is no longer the only information available downstream: zero valid observations can be distinguished from a legitimate black sample.
- `MilkyWayPipelineResult` carries the contribution store to downstream/export stages.
- Both Milky Way convenience export wrappers dispose the additional store on success/failure.
- Allocation failure and stack failure paths abort temporary stores rather than intentionally leaving partial data.

## Deliberately not done yet
- No DNG Transparency Mask IFD has been emitted yet. The validity data required to build one without guessing is now preserved, but writing the mask is a separate TIFF/DNG structural change and should be implemented/tested as its own batch.
- No kappa/sigma/pixfrac tuning was changed without image-specific evidence.

## Evidence / rationale
- Adobe describes DNG as a publicly documented archival RAW format and publishes DNG 1.7.1 plus the DNG SDK. The current Adobe page lists DNG SDK 1.7.1 Build 2652 (2026-07-14). DNG/TIFF structural changes should therefore be validated against the published specification/SDK rather than inferred.

## Validation
- Node/reference + source-contract suite: 403/403 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable in this environment: Dart analyze/tests/APK were not executed.
