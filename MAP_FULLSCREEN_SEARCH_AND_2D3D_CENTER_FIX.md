# Map fullscreen search / 2D→3D center fix

## Changes

1. Fullscreen spot-search bar
   - No longer spans underneath the left 2D/3D/pin rail.
   - Starts to the right of the rail and uses only the remaining width.
   - Includes mobile and safe-area offsets.

2. 2D to 3D transition
   - The former 2D center is now used as the 3D camera target.
   - Uses `flyToBoundingSphere` with `HeadingPitchRange` rather than placing a pitched camera directly above the target.
   - Prevents the 2D center from moving toward or beyond the bottom edge after switching to 3D.
