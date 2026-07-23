# Stage 5C: Foreground preview ECEF unification

## Scope
Only the foreground-person preview overlay calculation was changed.

## Finding
`src/components/ForegroundPreviewOverlay.tsx` still used a local spherical distance/bearing implementation and planar elevation approximation (`atan2(height difference, distance)`). This was active code, not unused code, and was the remaining exception to the shared ECEF elevation path.

## Change
- Removed the local Earth-radius distance/bearing helper.
- Reused `calculateLineMetrics()` for bearing and ground distance.
- Reused `calculateElevationAngleDegrees()` for subject, object base, and object top elevation.
- Used the lens-center height as the observer height.
- Kept sensor/FOV calculation, object rendering, visibility checks, and UI unchanged.

## Verification
- TypeScript syntax transpilation diagnostics for the changed TSX file: 0.
- Search of `src/components`, `src/search`, and `src/cesium` found no remaining active `atan2(height difference, distance)` elevation calculation.
- Full project build remains unverified because package installation is unavailable in the execution container.
