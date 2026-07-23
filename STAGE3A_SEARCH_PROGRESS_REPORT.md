# Stage 3A: Search progress indicator

## Scope
Only item 5 (search progress display) was changed.

## Changes
- Added independent numeric progress state to the celestial transit search dialog.
- Added a compact progress bar and integer percentage display.
- Progress is calculated from the full scan range and advances for every scanned sample, including samples excluded by weekday or time-range filters.
- UI updates occur only when the integer percentage changes (0-100), limiting React updates to about 101 per search.
- Search-detail messages are hidden while searching. No elapsed time, remaining time, result count, current date/time, or other detail is displayed.
- Progress reports 100% on normal completion and when the requested result count is reached early.
- Existing abort/cancel behavior is retained.

## Files changed
- src/search/celestialTransitSearch.ts
- src/components/CelestialTransitSearchDialog.tsx
- src/App.css

## Verification
- Confirmed there is one caller of searchCelestialTransitDates and its callback now accepts a number.
- Confirmed both search modes share the same progress path.
- Confirmed skipped weekday/time samples also update progress.
- `npm run build` was attempted but could not start TypeScript compilation because installed dependencies/type definitions are absent (`vite/client`, `node`). Therefore a successful full build is not claimed.
