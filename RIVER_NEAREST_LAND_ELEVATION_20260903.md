# River nearest-land elevation

- Sea / authoritative GSI water no-data: orthometric elevation 0 m.
- River/canal polygon: no longer forced to 0 m.
- For a river candidate, search 8 directions at radii 3, 6, 10, 15, 25, 40, 60, 90, 140, 220 m.
- At each radius, use only samples confirmed outside mapped water with valid DEM+geoid.
- Stop at the first radius containing land; if several land samples exist at that radius, use their median orthometric elevation to suppress outliers.
- If no land can be confirmed within 220 m, do not invent 0 m; preserve the terrain-derived height path.
- Linear waterway=river/stream is not globally treated as zero, avoiding mountain-river corruption.

Verification:
- water/river dedicated regression: 12/12 PASS
- modified TypeScript syntax/transpile: PASS
- consolidated 3D invariants: 10/10 PASS
