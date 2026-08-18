# Stage 6A11 — Karney preview camera correction bearing

## Scope

Only the optional preview camera correction branch in `src/cesium/camera.ts` was changed.

When azimuth/altitude view correction is applied, the tripod-to-subject initial bearing now comes from `calculateKarneyLineMetrics()` on the WGS84 ellipsoid instead of the legacy spherical `calculateLineMetrics()` implementation.

## Intentionally unchanged

- The uncorrected camera direction/up vectors remain ECEF/Cesium based.
- Camera altitude continues to use the existing ECEF dot-product calculation.
- Focal length and frustum calculations are unchanged.
- Foreground overlay calculations are unchanged.
- Terrain, occlusion, search, and celestial-coordinate calculations are unchanged.

## Risk containment

The new calculation is used only when `viewCorrection` is present. The normal camera path is untouched.
