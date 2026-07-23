# Stage 6A-12: Karney foreground preview switch

## Scope

The foreground preview overlay now uses WGS84 Karney inverse geodesics for:

- tripod to subject ground distance and initial bearing
- tripod to foreground object ground distance and initial bearing

## Unchanged

- elevation angles remain based on the existing ECEF calculation
- foreground object height projection remains unchanged
- Cesium entities, terrain, occlusion, and search logic are unchanged
- the 0.2 m near-object rejection threshold is unchanged

## Rationale

This is an isolated rendering path. Switching only the horizontal ground distance and bearing keeps the vertical projection and all search behavior unchanged while removing another spherical-geodesic dependency.

## Additional type correction

`calculateKarneyDestinationPoint()` now preserves `origin.label`. `GroundPoint.label` is required, and the Stage 6A-10 return object omitted it. This correction does not alter coordinates or candidate-search behavior.
