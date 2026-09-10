# Celestial bearing pruning — 2026-09-10

- Direct surrounding-data download no longer requests all 360 bearings unconditionally.
- It derives the physically required tripod-bearing band from subject latitude.
- Targets remain Sun, Moon, and Milky Way center.
- Conservative declination envelope: +28.75° north (Moon), -29.01° south (Milky Way center).
- Tripod bearing is the opposite (+180°) of celestial azimuth.
- 3° safety margin is retained.
- Low latitudes where the declination envelope can cross the zenith keep all 360 bearings rather than risk omissions.
- Search maximum distance remains precision-settings driven (default 10 km).
- DEM source priority, 1° bearing resolution, 1m high-precision sampling, R2 behavior, and final candidate verification are unchanged.
