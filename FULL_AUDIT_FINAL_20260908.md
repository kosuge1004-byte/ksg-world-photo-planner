# AstroSight full audit final pass — 2026-09-08

## Scope
- Full source tree from AstroSight-full-audit-batch-fixed-20260908.zip
- 98 verify scripts executed individually before final patch
- Tripod candidate precision path re-inspected: weather, ECEF convergence, DEM/geoid datum, water/river handling

## Baseline execution
- verify scripts: 98 total / 67 PASS / 31 non-zero
- The 31 non-zero results are not 31 confirmed app defects. They include stale contract tests and environment/dependency blockers (TypeScript, geo-tz, geographiclib-geodesic, direct Node .ts imports, Android synced web assets).

## Confirmed defect fixed in this pass
River nearest-land branch preserved orthometric H from nearby land but finalized ellipsoidal h with only sampled candidate/land geoid N. It bypassed the point-specific final geoid helper used by normal/sea candidates.

Fix:
1. Preserve nearest-land orthometric H.
2. Build candidate Cartographic using sampled N only as the initial/fallback datum.
3. Run buildPointSpecificFinalCandidateGroundPoint at the actual river candidate coordinate.
4. Prefer point-specific N and reconstruct h = H + N.
5. Fall back to sampled N only if point-specific N cannot be obtained.

This keeps the user's river-nearest-land behavior while aligning final river datum precision with the normal tripod finalization path.

## Validation after patch
- New river point-specific final geoid regression: PASS 4/4
- TypeScript `npx tsc --noEmit`: PASS
- Existing relevant tripod/weather/water/download regressions re-run: PASS where executable.

## Remaining non-zero verify scripts
Do not interpret them as confirmed source defects without updating/running their current contracts. Known categories:
- stale tests for old centerline/apparent-preview/CameraModel round-trip algorithms;
- stale UI contracts (normal tap subject pin, tripod manual offset, old Cesium render-loop/normals, old Cesium Usage label);
- tests that search old variable/function text despite equivalent current implementation;
- environment blockers: missing npm packages, direct Node TypeScript import, missing Android synced web assets.

No source was reverted merely to satisfy a stale historical test.
