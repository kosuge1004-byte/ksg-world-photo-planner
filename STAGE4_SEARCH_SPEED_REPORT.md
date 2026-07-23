# Stage 4 Search Speed Improvement

## Scope
- Requirement 7: weather data is fetched before the search loop.
- No network access occurs inside `searchCelestialTransitDates`.
- Cached weather data is reused.

## Changes
1. Forecast samples are sorted once after download.
2. Forecast lookup changed from a full linear scan for every celestial sample to binary search.
3. Concurrent requests for the same rounded location and source share one in-flight Promise.
4. Existing persistent cache behavior remains unchanged.
5. API failure still falls back to standard atmosphere without stopping search.

## Network audit
`searchCelestialTransitDates` contains no `fetch`, terrain sampling, or geoid API access. The only asynchronous yields in the loop use `setTimeout(..., 0)` to keep the UI responsive.
