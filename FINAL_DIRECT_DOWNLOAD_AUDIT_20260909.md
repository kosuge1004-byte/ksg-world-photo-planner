# AstroSight direct-download final audit — 2026-09-09

## Verification
- verify scripts discovered: 108
- PASS: 93
- FAIL in this environment: 15

## Confirmed code regression fixed during audit
`verify-gsi-tier-request-reduction-20260909.mjs` still expected DEM5A/5B/5C to run together.
That expectation was stale after DEM5A gating. The test now verifies:
DEM1A -> DEM5A -> unresolved-only DEM5B/DEM5C parallel -> unresolved-only DEM10B.

## Core download-path verification
- GSI tier reduction: PASS 8/8
- HTTP wave reduction: PASS 6/6
- direct download regression: PASS 13/13
- R2 safety all paths: PASS 11/11

## Remaining failed scripts
These are not confirmed app regressions from this audit. They require unavailable dependencies,
native synchronized assets, or artifacts not present in this source ZIP:
- verify-android-native.mjs
- verify-device-dem-tile-cache-20260829.mjs
- verify-final-cleanup.mjs
- verify-focal-length-input.mjs
- verify-geocode-api-fallback-20260830.mjs
- verify-geodesic-comparison.mjs
- verify-geodesic-direct.mjs
- verify-gifu-geocode-priority-20260824.mjs
- verify-google-maps-url-live.mjs
- verify-google-maps-url.mjs
- verify-gsi-large-batch-runtime-20260829.mjs
- verify-phase6-5-final.mjs
- verify-phase7-1-foundation.mjs
- verify-phase7-5-final-release.mjs
- verify-tripod-speed-cache-20260829.mjs

Full production npm build remains unverified in this environment because the dependency tree is not installed.
