# Build audit before 5 m DEM integration

Date: 2026-07-24
Baseline: stage6a14-20

## Result

A complete production build could not be executed in this environment because npm registry DNS resolution is unavailable.

Observed network failure:

- `registry.npmjs.org` could not be resolved.
- `npm ci` therefore could not download dependencies.

## Commands attempted

- `npm ci --no-audit --no-fund`
- `tsc -b --pretty false`
- connectivity check to `https://registry.npmjs.org/typescript`

## TypeScript result before dependency installation

Compilation stopped at missing external type packages:

- `vite/client`
- `node`

These errors do not establish a source-code defect; the corresponding dependencies were not installed.

## Checks that passed

- `package.json` JSON validation
- `package-lock.json` JSON validation
- Python GeographicLib reference verification: all 4 cases passed
  - short local
  - Nagoya to Tokyo
  - dateline
  - near antipodal
- Runtime source scan found no remaining fixed-radius / haversine markers searched for:
  - `6371000`
  - `6371e3`
  - `haversine`
  - legacy `111132` / `111320` constants

## Required build verification on a network-enabled machine

Run from the project root:

```bash
rm -rf node_modules
npm ci
npm run build
npm run verify:geodesic
npm run verify:geodesic:direct
npm run verify:geodesic:reference
```

On Windows PowerShell, use:

```powershell
Remove-Item node_modules -Recurse -Force -ErrorAction SilentlyContinue
npm ci
npm run build
npm run verify:geodesic
npm run verify:geodesic:direct
npm run verify:geodesic:reference
```

Do not begin 5 m DEM integration until `npm run build` succeeds or any resulting source errors are corrected.
