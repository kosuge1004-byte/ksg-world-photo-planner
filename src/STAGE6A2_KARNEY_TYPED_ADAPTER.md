# Stage 6A-2: Karney typed adapter

## Scope

This stage adds the official `geographiclib-geodesic` package declaration and a typed WGS84 inverse-geodesic adapter. Existing production call sites are intentionally unchanged.

## Added

- Dependency: `geographiclib-geodesic` `^2.2.0`
- `src/geodesy/karneyGeodesic.ts`
- Minimal local module declaration for the API used by the adapter

## Behavior

`calculateKarneyLineMetrics()` returns:

- ellipsoidal surface distance in metres
- normalized initial bearing in degrees `[0, 360)`
- existing height difference value

## Safety boundary

`src/cesium/geometry.ts` still uses the current spherical calculation. No UI, preview, search, or pin-placement behavior changes in this stage.

## Verification limits

The package download timed out in the execution environment. The adapter and declaration were syntax-checked, but runtime comparison and full Vite build require dependency installation in a normal npm environment.
