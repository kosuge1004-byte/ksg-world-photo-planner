# Stage 5D: Unused Code Audit

## Scope

- `src/search/**/*.{ts,tsx}`
- `src/cesium/**/*.{ts,tsx}`
- Related elevation calculations in `src/components`

## Checks performed

1. Parsed all TypeScript/TSX files and compared imported identifiers against identifiers used outside import declarations.
2. Searched for legacy planar elevation patterns such as height-difference divided by distance and direct `atan2` elevation approximations.
3. Searched for explicit obsolete markers (`TODO`, `FIXME`, `deprecated`, old implementation comments) in the search and Cesium modules.
4. Rechecked the shared ECEF elevation path introduced in Stage 5B/5C.

## Result

- No unused imports were found in the inspected source tree.
- No active legacy planar elevation calculation was found.
- No safely removable unreachable branch or obsolete helper was identified by this audit.
- `heightDifferenceMeters` in `src/cesium/geometry.ts` remains used by the metrics display and is not obsolete.

## Decision

No source code was removed in this stage. Removing code without a verified unused call path would create unnecessary regression risk and would conflict with the requirement to preserve existing functions.

## Build status

A full project build still requires the project dependencies. This audit used TypeScript AST parsing available in the environment and source-level searches; it is not a substitute for a successful `npm run build`.
