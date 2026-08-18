# Stage 6A-5: Karney UI metrics limited switch

## Scope

Only the top-level tripod-to-subject metrics calculated in `src/App.tsx` were switched from the existing spherical `calculateLineMetrics()` function to `calculateKarneyLineMetrics()`.

## Changed behavior

The distance and initial bearing supplied by the App-level `metrics` memo now use the WGS84 Karney inverse solution.

## Intentionally unchanged

The following still use the existing spherical calculation:

- celestial transit search
- in-frame search
- Cesium camera placement
- foreground preview overlay
- tripod candidate search
- celestial preview orientation

This limits the first production connection to a display-level path and avoids changing search results or camera geometry in the same stage.

## Dependency condition

`geographiclib-geodesic` remains an npm dependency. The current execution environment could not download the package, so a complete `tsc -b` and Vite production build could not be performed here.
