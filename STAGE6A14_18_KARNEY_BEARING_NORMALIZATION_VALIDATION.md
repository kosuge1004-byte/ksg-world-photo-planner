# Stage 6A-14-18: Karney bearing normalization validation

## Change

Centralized finite-number validation for all bearings inside `normalizeBearingDegrees()`.

- Inverse geodesic result bearing is validated at normalization.
- Direct geodesic input bearing is validated at normalization.
- Duplicate bearing checks were removed.

## Runtime impact

No change for valid finite inputs. Invalid `NaN` or infinite bearings fail at the single normalization boundary with a field-specific error.

## Not changed

UI, search conditions, DEM, occlusion logic, camera calculations, and GeographicLib formulas were not changed.
