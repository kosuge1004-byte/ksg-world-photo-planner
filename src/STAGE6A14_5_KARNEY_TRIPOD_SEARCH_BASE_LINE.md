# Stage 6A-14-5: Karney tripod search base line

## Scope

Only the endpoint generation for the shared tripod-search base line was changed.

## Change

`src/cesium/tripodSearchLine.ts` no longer uses a fixed mean Earth radius and spherical direct-geodesic formula. It now calls `calculateKarneyDestinationPoint()` using the WGS84 ellipsoid.

The existing behavior is preserved:

- line length remains 250,000 m
- direction remains the celestial azimuth plus 180 degrees
- endpoint height remains subject height plus 0.2 m
- endpoint label remains unchanged

## Not changed

- search candidate generation
- DEM elevation lookup
- celestial calculations
- UI
- search timing and result logic
