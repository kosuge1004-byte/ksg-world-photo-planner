# Netlify production API route repair

## Change

Added explicit `[[redirects]]` entries to `netlify.toml` so every public `/api/...` endpoint used by the application is forwarded to its corresponding Netlify Function in production.

## Route map

- `/api/resolve-google-maps` -> `/.netlify/functions/geocode`
- `/api/gsi-elevation` -> `/.netlify/functions/gsi-elevation`
- `/api/gsi-geoid` -> `/.netlify/functions/gsi-geoid`
- `/api/osm-site-context` -> `/.netlify/functions/osm-site-context`
- `/api/spot-search-start` -> `/.netlify/functions/spot-search-start`
- `/api/spot-search-status` -> `/.netlify/functions/spot-search-status`
- `/api/spot-search-background` -> `/.netlify/functions/spot-search-background`
- `/api/spot-search-finalize` -> `/.netlify/functions/spot-search-finalize`
- `/api/timezone` -> `/.netlify/functions/timezone`

## Important detail

A single wildcard redirect was not used because the public endpoint `/api/resolve-google-maps` is implemented by `netlify/functions/geocode.ts`; its public route and function filename do not match. Explicit mappings avoid routing that endpoint to a nonexistent `resolve-google-maps` function.
