# Stage 6A14-20: Karney inverse distance postcondition

## Change

Added an explicit postcondition to `calculateKarneySurfaceMetrics()` that rejects a negative `s12` returned by GeographicLib.

## Reason

A geodesic distance is always non-negative. The adapter already checked that `s12` was finite, but it did not enforce this domain invariant. Detecting an invalid library result at the adapter boundary prevents malformed distance values from propagating into preview, search, OSM projection, and structure filtering paths.

## Runtime impact

No change for valid GeographicLib results. Only an impossible negative inverse-distance result now throws an explicit error.

## Scope

No UI, search algorithm, DEM, occlusion, refraction, or camera behavior was changed.
