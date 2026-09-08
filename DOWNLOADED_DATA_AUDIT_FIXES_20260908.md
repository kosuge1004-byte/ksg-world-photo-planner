# Downloaded data audit fixes — 2026-09-08

Fixes applied after full-day audit:
1. Refresh now forces re-fetch of all 360 bearing profiles and high-precision DEM/OSM/water data.
2. DEM spot references are merged (union) with existing references, preventing resume/update from losing prior tile ownership.
3. Complete state now requires referenced/live DEM and referenced/live site-context data.
4. Progress reports terrain, water/river, OSM, and finalizing phases; no false "100% done" while network work continues.
5. Preflight storage estimate blocks download when estimated remaining quota is insufficient; actual IndexedDB DEM write failures are counted and prevent marking the spot complete.
6. High-precision and site-context regression scripts are wired into the main regression runner.
7. Added verify-downloaded-data-audit-fixes-20260908.mjs (12/12 PASS).

Validation in this environment:
- npx tsc --noEmit: PASS
- audit-fix regression: 12/12 PASS
- downloaded data management detail: 13/13 PASS
- shared DEM refs: 9/9 PASS
- high precision: 7/7 PASS
- site context: 8/8 PASS
- tripod timeout elimination: 15/15 PASS
- water/river: 12/12 PASS
- Full regression runner starts and passes all newly added downloaded-data suites, then stops at production calculation regression because local project dependencies do not contain the `typescript` package used by scripts/typescript-source-loader.mjs. This is an environment dependency failure, not reported as a source test pass.
