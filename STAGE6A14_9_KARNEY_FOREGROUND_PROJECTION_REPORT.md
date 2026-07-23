# Stage 6A-14-9: Karney foreground segment projection

## Scope

Only the projection ratio used while constraining the foreground marker to the tripod-subject segment was changed.

## Before

The projection ratio was estimated with fixed metres-per-degree constants:

- latitude: 111132 m/degree
- longitude: 111320 * cos(mean latitude) m/degree

## After

The projection now uses two WGS84 Karney inverse solutions:

1. tripod to subject
2. tripod to the dragged foreground position

The dragged position is projected onto the initial tripod-subject direction using the Karney distance and bearing difference. The existing 1%-99% clamp and Karney direct endpoint generation are unchanged.

## Unchanged

- UI
- drag event flow
- foreground height
- 1%-99% endpoint exclusion
- celestial search
- DEM and occlusion processing
