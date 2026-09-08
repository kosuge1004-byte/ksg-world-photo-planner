# AstroSight full audit continuation 2 — 2026-09-08

## Scope
Continued from AstroSight-full-audit-continued-20260908.zip. No production tripod-candidate algorithm was changed in this pass.

## Regression tests updated to current verified implementation
The following tests were stale structural/string assertions and were updated without changing production behavior:
- verify-cesium-root-usage-counter-20260907.mjs: current UI wording is 「公式Usageの値を手動反映」.
- verify-3d-map-smoothness-20260823.mjs: controlled manual Cesium rendering uses useDefaultRenderLoop=false; terrain normals follow terrainShadingEnabled.
- verify-phase4-1-precision-mode.mjs / verify-phase4-4-weather.mjs: weather/refraction mode is independent from paid accuracy mode; refractionCorrectionMode controls standard vs weather.
- verify-phase5-2-device-cache.mjs: weather cache reads through migrateLegacyLocalStorage and writes through setDeviceCache; direct getDeviceCache string is not required.
- verify-preview-tap-subject-pin-20260831.mjs: normal preview subject placement is long-press; explicit picking/measurement/pinch remain.
- verify-tripod-air-offset.mjs: manual height offset is person-only; tripod/subject ground height is automatic.
- verify-tripod-centerline-rebuild-20260830.mjs: obsolete centerline solver is intentionally absent; authoritative path is ECEF backward ray + candidate weather + altitude/azimuth convergence.
- verify-tripod-preview-inverse-root-fix-20260830.mjs: obsolete apparent-preview/centerline seeds are absent; current ECEF apparent-altitude correction and final convergence gate are checked.
- verify-phase7-3-celestial-3d.mjs: Google photorealistic loading now explicitly resolves ion asset 2275207 and calls Cesium3DTileset.fromUrl so root usage can be counted accurately; geocoder uses IonGeocodeProviderType.GOOGLE.

## Results
- verify-*.mjs total: 99
- PASS: 83
- non-zero: 16
- TypeScript `npx tsc --noEmit`: PASS

## Remaining 16 classification
Environment/artifact blocked:
- verify-android-native: synced Android web assets absent in ZIP.
- verify-final-cleanup: local `typescript` package unavailable to direct Node import in this validation environment.
- verify-geodesic-comparison / verify-geodesic-direct: `geographiclib-geodesic` unavailable.
- verify-phase6-5-final: historical artifact `PHASE6_1_LOS_PERFORMANCE.md` absent.
- verify-phase7-1-foundation: dependency installation incomplete (`typescript`, `vite`, `oxlint`, `@types/node`, `@cloudflare/workers-types`, `geo-tz`).
- verify-phase7-5-final-release: cascades from phase6-5/phase7-1 failures.

Old Node execution mechanism (imports .ts directly under Node 22 and fails ERR_UNKNOWN_FILE_EXTENSION before assertions):
- verify-device-dem-tile-cache-20260829
- verify-focal-length-input
- verify-geocode-api-fallback-20260830
- verify-gifu-geocode-priority-20260824
- verify-google-maps-url-live
- verify-google-maps-url
- verify-gsi-large-batch-runtime-20260829
- verify-tripod-speed-cache-20260829

Needs product/spec confirmation rather than silent test rewrite:
- verify-phase7-2-search expects SpotSearchScreen pause/resume (`onResumeSearch`, `isPaused`). Current SpotSearchScreen contains neither, and no current source/doc evidence in this ZIP proves whether removal was intentional. This remains an unresolved regression candidate; production code was not changed in this pass.

## Tripod-candidate safety note
No production changes were made to `src/cesium/tripodCandidates.ts` or related tripod computation in this pass. The updated tripod tests only align assertions with the already-current algorithm established in the previous audited ZIP.
