# Phase E-3: Karney edge cases and postconditions

## Changes

- Retained the 1e-6 m coincident-point guard.
- Coincident points return distance 0 and bearing 0 as an explicit sentinel; callers must inspect distance first.
- Added inverse-to-direct round-trip postcondition verification for geodesics of 19,000 km or longer.
- The round-trip endpoint must match the requested endpoint within 1e-8 degrees in latitude and wrapped longitude.
- Added explicit complete-antipodal verification coverage. The distance is strict; the initial bearing is treated as non-unique.
- Normal-distance calculations do not incur the extra Direct calculation.

## Verification limits

The archive does not contain a complete installable node_modules tree, so full `tsc -b` and npm regression execution could not be completed in this environment. Static source verification and an independent Python GeographicLib round-trip check were executed.
