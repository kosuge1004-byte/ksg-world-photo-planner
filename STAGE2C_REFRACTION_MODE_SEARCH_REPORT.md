# Stage 2C: Refraction mode connection to celestial transit search

## Scope

This stage connects the existing precision setting to both celestial transit search modes without adding weather/network access yet.

## Behavior

- `standard`: Astronomy Engine standard atmospheric refraction (`Horizon(..., "normal")`).
- `none`: geometric horizontal coordinates with no atmospheric refraction.
- `auto`: temporarily uses the standard-atmosphere fallback. Weather forecast and climatology prefetch will be added in the next stage.

## Affected search modes

- Direction crossing search
- In-frame closest-time search

Both the coarse scan and refinement calculations use the same resolved calculation mode because it is supplied through the common `SearchInput`.

## Files changed

- `src/components/CelestialTransitSearchDialog.tsx`
- `src/App.tsx`
