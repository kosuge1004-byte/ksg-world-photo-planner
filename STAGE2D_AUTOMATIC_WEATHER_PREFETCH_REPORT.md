# Stage 2D: Automatic refraction weather prefetch

- Added search-start weather prefetch outside the time scanning loop.
- Auto mode uses a 7-day hourly forecast only when the complete search interval is within 7 days.
- Longer searches use five complete years of hourly reanalysis data and aggregate it by UTC month/hour.
- Forecast cache: 3 hours. Climatology cache: 30 days. Coordinates are grouped at 0.05 degrees.
- Any network, response or storage failure falls back to standard atmosphere without stopping the search.
- This stage prepares and passes weather context. Applying temperature/pressure/humidity to a custom refraction formula is intentionally deferred to the next stage.
