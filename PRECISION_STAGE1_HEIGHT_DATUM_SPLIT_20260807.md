# Precision Stage 1: Height datum separation

Implemented explicit height datum fields on `GroundPoint` while retaining the legacy `height` field for project compatibility.

- Cesium/ECEF paths use `ellipsoidalHeightMeters()`.
- Astronomy Engine observer paths use `orthometricHeightMeters()`.
- Terrain-resolved points store ellipsoidal height, orthometric height, geoid separation, and source.
- Lens-center points increment both height datums through `withLensCenterHeight()`.
- Invalid terrain height no longer silently becomes zero in `groundPointFromCoordinates()`.

The legacy fallback remains only for previously saved points that do not yet contain split height metadata. Newly resolved points are explicit.
