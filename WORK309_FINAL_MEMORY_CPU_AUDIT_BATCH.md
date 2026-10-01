# Work309 — Detection CPU/memory hardening + residual production audit

## Implemented in this batch

### 1. Star detector background statistics
The stride-sampled robust background pass now uses one pre-sized Float64List
and reuses it for MAD. Formula, sampled coordinates, sorting and percentile are
unchanged. This removes growable/boxed List overhead.

At 60 MP with the production default sample stride 4, the sample count is about
3.75 M. One packed Float64 buffer is about 30 MB decimal.

### 2. Streak detector background statistics
The streak detector previously held both the sorted sample list and a second
MAD-deviation list. It now uses one pre-sized Float64List and transforms that
same buffer to absolute deviations before the second sort.

At 60 MP/stride 4, this removes one roughly 30 MB numeric sample plane, plus
boxed-list overhead that is runtime-dependent.

### 3. Streak connected-component visited map
The detector's full-resolution visited state changed from one byte/pixel to one
bit/pixel. Flood-fill order, threshold comparisons, 8-connectivity and
maxRegionPixels are unchanged.

Source-derived sizes:
- 33 MP: ~33 MB -> ~4.1 MB
- 60 MP: ~60 MB -> ~7.5 MB

### 4. Meteor selected-streak compositing
The production in-place compositor no longer allocates a Uint8 mask for the
whole output tile and then scans every tile pixel. It directly evaluates only
each selected streak's padded bounding box and applies the same per-channel
max. Overlap is exactly safe because max with the same foreground pixel is
idempotent.

The public buildStreakMask API is retained for UI/inspection/tests.

## Residual full-resolution allocations reviewed

### Required by current exact algorithms
- Full-resolution single-channel green plane for star/streak detection:
  Float32, 4 bytes/pixel (~240 MB at 60 MP). The detector APIs require random
  access across the complete plane. Removing this without changing detector
  architecture is a larger algorithm rewrite, not a safe storage-only patch.
- JPEG export: the current Dart `image` JPEG encoder requires one complete RGB8
  image backing store (~180 MB at 60 MP). BMP/TIFF/DNG paths are already
  streamed. Replacing this requires a row-streaming native JPEG encoder.

### Legacy/reference-only large allocations
Static reachability review confirms the large full-image arrays in the old CFA
Drizzle reconstruction / old whole-image robust combine / old in-memory focus
winner paths are retained for tests or compatibility, while current production
session paths use the file-backed/tiled replacements added in Work303–Work306.

### Tile-bounded allocations
The `TiledKappaSigmaCombiner` and `TiledLightenBlendCombiner` allocate full
arrays only for the current output tile/band, not the sensor frame. Production
Milky Way and star-trail session paths call these tiled combiners.

## CPU/I/O observations
- Kappa-sigma already has a bounded aligned-frame cache (32 MiB default) to
  avoid repeated resampling/file reads when the current band fits.
- Auto-tone samples at most 500,000 pixels and is not a full-frame allocation.
- TIFF16/BMP/Linear DNG output are strip/row streamed.
- JPEG remains the principal non-streamed display export.

## Validation available in this environment
- Static source/wiring checks.
- Streak direct-compositor parity test source added.
- Native tree unchanged from Work308.
- ZIP CRC PASS.
- Dart/Flutter SDK unavailable: no analyzer/test/APK/device RSS or thermal run.
