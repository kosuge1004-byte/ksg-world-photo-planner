# Downloaded spot shared DEM reference management (2026-09-08)

- GSI DEM IndexedDB schema bumped to v2 and adds `spotRefs`.
- High-precision spot download records deterministic DEM tile keys per subject.
- Completion waits for currently in-flight matching tile prefetch, records tile count and actual decoded DEM byte size.
- Downloaded-data list shows per-spot measured DEM bytes and total measured bytes.
- Deleting one spot removes only DEM tiles that no other downloaded spot references; shared tiles are retained.
- Valid DEM tiles have no app-imposed count eviction. Browser/device storage quota still applies.
- Google Photorealistic 3D Tiles are not persisted by this implementation.
