# Phase C: constrained bicubic terrain interpolation

- Standard / 5m / 10m requests continue to use Bilinear interpolation.
- Requests marked maximumDetail="1m" use constrained bicubic interpolation.
- The bicubic result is clamped to the minimum and maximum of the central 2x2 cell.
- Any NO_DATA value in the required 4x4 neighborhood falls back to Bilinear.
- Tile-edge samples currently reuse clamped edge pixels, matching the existing boundary policy.
- Added regression coverage for planar reproduction and overshoot prevention.

Remaining work:
- Cross-tile 4x4 neighborhood loading at tile edges.
- Browser/server dependency separation.
- Full tsc/build after dependency resolution is repaired.
