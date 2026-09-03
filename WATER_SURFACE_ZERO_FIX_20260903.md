# AstroSight water-surface zero elevation fix

## Implemented behavior
- Sea / DEM-uncovered water surface: when the GSI elevation API returns successfully with no elevation/source for a point, treat orthometric elevation H as 0 m.
- Wide mapped river/canal water surfaces: OSM polygon tags natural=water, water=river, water=canal, waterway=riverbank are treated as H=0 m for final tripod candidate height.
- Linear waterway=river/stream is intentionally not globally zeroed, avoiding automatic zeroing of narrow mountain rivers.
- Cesium internal height remains ellipsoidal, so water H=0 is converted to h=N using the available geoid height.
- GSI communication failures are not treated as water/no-data and therefore are never automatically forced to 0 m.

## Verification
- Water-surface dedicated regression: 14/14 PASS
- Existing consolidated 3D regression invariants rechecked: 14/14 PASS
- TypeScript syntax/transpile check for all modified TS files: PASS
- Dedicated verifier registered in scripts/run-regression-tests.mjs

## Build limitation
A dependency-resolved full npm build was not executed in this environment because the source ZIP does not contain node_modules. The modified TypeScript files were parsed/transpiled with the installed TypeScript compiler API without syntax errors.
