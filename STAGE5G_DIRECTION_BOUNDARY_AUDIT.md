# Stage 5G: Direction-search boundary audit

## Scope

- Search start/end time boundaries
- Weekday boundaries
- Date rollover
- 0°/360° azimuth wrapping
- Multiple bodies in the same sample interval
- Display count = 1
- Abort checks during refinement

## Finding

Direction-crossing search discarded samples outside the selected weekday/time window before calculating celestial azimuths. When the selected start or end time was not aligned to the 10-minute coarse sample grid, a crossing immediately after the start or immediately before the end could not be bracketed and was missed.

Example: a search window starting at 08:05 samples 08:00 and 08:10. The old logic discarded 08:00, so a crossing at 08:06 had no previous sample for refinement.

## Change

Direction-crossing mode now keeps adjacent coarse samples across weekday/time boundaries, refines any detected crossing, and adds the result only when the refined crossing time itself satisfies the selected weekday and time range.

In-frame mode retains its existing behavior in this stage. Its frame-interval boundary handling will be audited separately to avoid combining two behavior changes.

## Unchanged

- Signed angular difference and 0°/360° wrap protection
- Same-sample multi-body result ordering
- Display-count slicing
- Altitude threshold
- Refraction/weather/geoid calculations
- UI

## Verification

- TypeScript transpile diagnostics for the changed file: 0
- Full `tsc -b` and Vite build: not verified because required external type packages are unavailable in this environment
