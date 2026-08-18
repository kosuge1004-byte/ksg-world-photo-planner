# Build Recovery-2: IndexedDB type isolation

## Scope

Only `src/cesium/worldTerrain.ts` was changed.

## Change

- Removed direct compile-time references to the global DOM names `IDBDatabase` and `indexedDB`.
- Added minimal local structural types for the IndexedDB operations used by this module.
- Added `getIndexedDbFactory()` to resolve `globalThis.indexedDB` safely at runtime.

## Runtime behavior

- Supported browsers continue to use IndexedDB terrain/geoid caches.
- Environments without IndexedDB continue without persistent cache, as before.
- Terrain, geoid, search, preview, and Karney calculations were not changed.

## Reason

The Netlify build reported `TS2304` for `IDBDatabase` and `indexedDB`, even though the app tsconfig declares the DOM library. Isolating the small runtime surface avoids dependence on the build environment's global DOM type resolution.
