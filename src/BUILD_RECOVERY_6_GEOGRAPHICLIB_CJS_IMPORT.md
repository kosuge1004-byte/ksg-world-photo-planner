# Build Recovery 6 — GeographicLib CommonJS import compatibility

Netlify/Vite reported that `geographiclib-geodesic` is a CommonJS module and does not expose `Geodesic` as an ESM named export.

Changes:

- Replaced named imports with a default package import and destructuring.
- Updated the local TypeScript declaration to describe the CommonJS-compatible default export.
- Applied the same import form to both JavaScript verification scripts.

No geodesic calculations or runtime behavior for valid module loading were changed.
