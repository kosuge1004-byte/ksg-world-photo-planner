# Precision Stage 3: 3D surface picking

## Implemented

- Added `src/cesium/surfacePicking.ts` as the single 3D scene-surface picker.
- Removed every `pickEllipsoid()` fallback from `src`.
- Tripod, subject, and foreground placement now require a successful `scene.pickPosition()` result.
- Foreground drag uses the same picker as initial placement.
- A failed depth pick no longer silently substitutes the WGS84 ellipsoid surface.
- Placement remains active after failure and the UI requests another click/drag on a visible surface.

## Precision behavior

A roof, upper floor, observation deck, bridge deck, or terrain point is accepted only when Cesium returns that rendered 3D surface position. If depth picking is unavailable or fails, no coordinate is committed.

## Scope

This stage changes only explicit 3D surface selection. 2D placement, URL/search placement, and automatic candidates continue to use the Stage 2 height resolver.
