# Work305 — Focus winner-map full-plane removal

## Confirmed Work304 production peak
The focus-stack winner path retained:
- Int32 winner label for every pixel: 4 bytes/pixel
- Float32 confidence for every pixel: 4 bytes/pixel

That is 8 bytes/pixel persistently through regularization and final blending.
At 60 MP this pair is ~480 MB decimal. This is source-derived allocation
arithmetic, not measured Android RSS.

## Work305 production-path change
- Winner selection from measure files now writes labels/confidence directly to
  file-backed planes in bounded chunks.
- Adjacent-frame order refinement reads/writes bounded chunks.
- Two-pass spatial regularization is file-to-file and reads only the current
  row neighborhood.
- Final tiled focus blending reads only the winner-map tile needed for the
  current RGB output tile.
- Existing in-memory APIs remain for compatibility/reference tests.

## Semantics preserved
- same best/second-best winner selection
- same confidence equation
- same adjacent-frame refinement threshold/ratio
- same two regularization iterations
- same weighted-median neighborhood rule
- same anchor confidence and minimum neighbor support defaults
- same final blend implementation for each tile

## Remaining focus full-plane allocation
`FocusStoredBlendResult.coverage` is still Uint8, one byte/pixel. At 60 MP this
is ~60 MB and feeds Linear DNG validity/export. It is materially smaller than
the removed 8-byte/pixel winner pair and is a later optimization target.

## Validation
- Static production wiring checked.
- Source parity tests added for winner selection and regularization.
- Native tree unchanged from Work304.
- Flutter/Dart SDK unavailable; Dart tests/analyze/APK/device RSS not run.
