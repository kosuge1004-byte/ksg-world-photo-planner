# Phase 1 actual verification

Date: 2026-08-06
Base archive: AstroSight-full-project-phaseE3.zip

## Scope

- Build configuration audit
- Node/browser dependency boundary audit
- Dependency restoration attempt
- TypeScript build attempt
- Lightweight verification scripts

## Findings

### Node/browser boundary

- `tsconfig.node.json` uses `lib: ["ES2023"]`; DOM types are not enabled.
- No runtime references to `window`, `document`, `indexedDB`, `IDBDatabase`, `DOMException`, `Navigator`, or `Storage` were found under `server/`, `functions/`, or `vite.config.ts`.
- The `window.location` strings found in `server/googleMaps.ts` are regular-expression patterns used to parse source text, not runtime browser-global access.
- No imports from `src/cache/deviceCache.ts` or `src/network/networkDiagnostics.ts` were found in the Node/server build path.

Conclusion: no additional source change was required for the Phase 1 Node/browser boundary.

## Commands and results

### Dependency restoration

Command:

```sh
npm ci --ignore-scripts
```

Result: failed before installation because the execution environment's npm proxy returned HTTP 404 for `youch-core@0.3.3`.

The project lockfile itself points to `registry.npmjs.org`; it was not rewritten.

### TypeScript build

Command:

```sh
tsc -b --pretty false
```

Result: could not start project type checking because dependencies and type packages were unavailable after `npm ci` failed. Missing type libraries included `vite/client`, `node`, and `@cloudflare/workers-types`.

This is not evidence of a source-code type error. The build remains unverified.

### Lightweight verification

Passed:

```sh
npm run verify:coordinate-serialization
npm run verify:karney-edge-cases
npm run verify:user-error-handling
```

## Phase 1 status

- Static Node/browser boundary audit: PASS
- Dependency restoration: BLOCKED BY NPM PROXY
- `tsc -b`: NOT VERIFIED
- `npm run build`: NOT VERIFIED
- Source changes: none required

Do not describe this archive as fully build-tested.
