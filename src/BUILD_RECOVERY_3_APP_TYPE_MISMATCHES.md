# Build Recovery 3 — App type mismatches

## Changes

- `src/components/ForegroundPreviewOverlay.tsx`
  - Narrowed `object.groundHeightMeters` with an explicit `typeof === "number"` check before constructing `GroundPoint`.
  - This resolves `number | undefined` errors without changing valid runtime behavior.

- `src/App.tsx`
  - Set `polaris: false` when applying a spot-search preset.
  - `SpotPresetResult.celestialId` is limited to `sun | moon | milkyWay`, so comparison with `polaris` was unreachable and caused TS2367.

## Scope

No search formulas, geodesic calculations, terrain processing, or UI layout were changed.
