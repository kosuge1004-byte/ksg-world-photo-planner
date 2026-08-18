# Spot search first-run cache notice

- Added cold/warm preparation-state detection per rounded subject coordinate, celestial body, and calculation mode.
- Shows a persistent first-run notice during progress polling.
- Shows a warm-cache notice on subsequent searches.
- Marks the preparation key only after background search and final 3D verification complete successfully.
- Keeps up to 120 recent preparation keys in localStorage.

This patch records preparation state and user guidance. It does not claim to persist server DEM/astronomical arrays across Netlify cold starts.
