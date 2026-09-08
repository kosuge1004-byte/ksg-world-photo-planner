# Downloaded spot data management detail (2026-09-08)

- Downloaded-data list now reports per-spot and aggregate managed-data sizes for:
  - GSI DEM tiles
  - bearing terrain profiles
  - persistent OSM/water Site Context
- Shared DEM/Site Context data is counted once in aggregate totals.
- Browser StorageManager usage/quota is displayed when the runtime exposes it.
- Per-spot status: saved / partial / update needed, based on live vs expired cache components.
- Added update action for each downloaded spot.
- Added checkbox multi-select deletion and delete-all, preserving shared-data safety.
- Added storage inspection helpers for device cache namespace, GSI DEM references, and OSM/water references.
- New regression: scripts/verify-downloaded-data-management-detail-20260908.mjs and wired into run-regression-tests.mjs.

Validation in this environment:
- npx tsc --noEmit: PASS
- detailed downloaded-data management regression: 13/13 PASS
- site-context cache regression: 8/8 PASS
- high-precision download regression: 7/7 PASS
- shared DEM reference regression: 9/9 PASS
- spot-search surrounding download choice regression: PASS
- npm run build: NOT completed because the validation environment is missing the geo-tz package required by the existing prebuild script.
