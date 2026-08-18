# Stage 6A-14-8: Karney foreground segment endpoint

## Change

`constrainForegroundToSegment()` previously returned a latitude/longitude produced by linear interpolation of degree values. The projection ratio remains a local screen-drag approximation, but the constrained coordinate is now generated on the WGS84 ellipsoid using the shared Karney inverse/direct helpers.

## Preserved behavior

- Foreground object remains clamped to 1%–99% of the tripod-subject segment.
- Drag projection ratio and UI behavior are unchanged.
- Height, ECEF elevation, search, DEM and occlusion logic are unchanged.

## Verification

- Old degree interpolation removed from the return path.
- Shared Karney helpers used for the final constrained coordinate.
