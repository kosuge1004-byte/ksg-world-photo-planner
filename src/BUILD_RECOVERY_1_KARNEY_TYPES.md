# Build Recovery 1 — Karney result type narrowing

Fixed TypeScript errors caused by GeographicLib result fields being typed as
`number | undefined` by the installed package declarations.

Changes in `src/geodesy/karneyGeodesic.ts`:

- `assertFiniteNumber` now accepts `unknown` and uses an assertion signature:
  `asserts value is number`.
- Inverse result fields `s12` and `azi1` are copied to local variables,
  validated, and only then used.
- Direct result fields `lat2` and `lon2` are copied to local variables,
  validated, and only then used.

No calculation formula or valid-input behavior was changed.
