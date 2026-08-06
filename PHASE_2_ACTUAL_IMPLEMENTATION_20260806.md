# Phase 2 actual implementation

## Confirmed existing implementation
- API request coordinates remain full JavaScript `number` values.
- GSI/OSM R2 and shared-request keys use separately quantized coordinates.
- Point-specific geoid requests send original coordinates and quantize only the shared key.
- Karney near-antipodal and exact-antipodal verification scripts exist.
- Long-distance Inverse→Direct postcondition checking exists.
- Focal length, sensor dimensions, FOV, and precision settings use double-precision JavaScript numbers.

## Change made in this phase
The coincident-point result previously returned only `distanceMeters: 0` and `bearingDegrees: 0`. That could be confused with a valid north bearing.

Added:
- `bearingDefined: false`
- `coincident: true`

Normal results now return:
- `bearingDefined: true`
- `coincident: false`

`LineMetrics` exposes the same flags as optional fields for compatibility. OSM local projection explicitly returns a zero vector for coincident points instead of interpreting the sentinel bearing as north.

## Verification
- `node scripts/verify-phase2-geodesy-precision.mjs`: passed.
- Full TypeScript build remains dependent on restoring external npm packages.
