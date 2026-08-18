# Stage 6A-1: Karney geodesic reference baseline

## Scope

This stage does not change application behavior.

It adds a dependency-free comparison script containing WGS84 inverse-geodesic reference values generated with GeographicLib's Karney algorithm. These values will be used to verify the future TypeScript integration before `calculateLineMetrics()` is switched.

## Added

- `scripts/verify-geodesic-reference.mjs`

The script compares the current spherical calculation against four reference cases:

1. Short local baseline
2. Nagoya to Tokyo
3. International Date Line crossing
4. Near-antipodal points

## Why this is separated

The official JavaScript implementation is distributed as `geographiclib-geodesic`. Package installation could not be completed in the current environment. Adding an unresolved import or editing the lockfile without a completed install would make the project less reliable.

## Current comparison

The spherical implementation differs from the WGS84 Karney reference by approximately:

- Short local: sub-meter distance and a small bearing difference
- Nagoya to Tokyo: hundreds of meters in distance
- Date Line crossing: tens of meters
- Near-antipodal: several kilometres and a large bearing difference

The exact values can be reproduced with:

```bash
node scripts/verify-geodesic-reference.mjs
```

## Next stage

Install `geographiclib-geodesic`, add a typed adapter, and run this reference suite. Do not switch application call sites until all reference cases pass.
