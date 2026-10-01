# TIFF-based RAW sample probe

`probe_tiff_raw.mjs` checks a user-owned TIFF-based RAW file without decoding
sensor pixels or writing an extracted preview:

```sh
node tool/raw_samples/probe_tiff_raw.mjs /path/to/sample.ARW
```

The dependency-free Node 24 tool:

- requires a regular, non-symlink classic TIFF file
- streams SHA-256 instead of loading the RAW file into memory
- follows at most 16 IFD, SubIFD, Exif IFD, and next-IFD links
- accepts at most 4096 entries per IFD
- validates every directory, offset, and byte range against the exact file size
- discovers JPEGInterchangeFormat/Length and single JPEG-compressed strips
- reads at most 8 MiB for the selected embedded JPEG
- chooses the largest valid candidate with deterministic tie-breaking
- parses JPEG dimensions and hashes the preview bytes
- records no source path in JSON output
- writes neither RAW nor preview bytes
- rejects a file that changes during probing

Successful output follows `tiff-raw-probe.schema.json`. It characterizes the
container and existing preview path only. It does not decode sensor pixels,
prove image provenance, or make ARW/NEF/other TIFF RAW formats production
decode-capable.

## Sony ARW lossless sensor reference

For Sony ARW files whose sensor IFD uses four-component tiled JPEG Lossless
(SOF3), predictor 1, and zero point transform, run:

```sh
node tool/raw_samples/decode_arw_lossless_reference.mjs /path/to/sample.ARW
```

The reference decoder validates classic-TIFF IFDs, 2x2 RGGB CFA metadata,
tile geometry, every tile range, JPEG markers, canonical DC Huffman tables,
14/16-bit prediction bounds, Sony `WB_RGGBLevels` metadata when present, and a
caller pixel limit. The WB levels are normalized against the mean of the two
green channels. It writes no image or RAW data. Its JSON output follows
`arw-lossless-reference.schema.json` and contains a deterministic SHA-256 of
the decoded row-major uint16 CFA mosaic.

This is intentionally narrower than the ARW extension as a whole. ARW files
using another Sony compression layout, JPEG predictor, point transform,
component geometry, or restart interval are rejected instead of being
silently misdecoded.

## RAW linear calibration reference

`raw_calibration_reference.mjs` independently verifies the application-side
calibration math without writing image data. It subtracts the repeating
black level relative to the ActiveArea origin, normalizes by
`WhiteLevel - max(BlackLevel)`, and multiplies optional camera-WB gains in
image-CFA order. Negative shadow values and values above 1.0 remain unclipped
for later high-quality noise and HDR processing.

## Explicit defect-pixel reference

`raw_defect_pixel_reference.mjs` verifies the application-side point-defect
algorithm. It patches only coordinates supplied by a trusted camera or RAW
metadata source, excludes all listed defects from its neighborhood, and uses
only offsets that retain the original CFA phase. Opposing horizontal,
vertical, and diagonal pairs are compared first; the smallest-gradient pair
is averaged. Image boundaries fall back to the median of available
same-phase neighbors. It intentionally performs no single-frame automatic
hot-pixel detection, so stars and other legitimate point sources are not
silently removed.

## Advanced adaptive demosaic reference

`mobile_stack_adaptive_demosaic_reference.mjs` is the dependency-free
clean-room numerical reference for the Dart and Native C11 tile
implementations. At a red or blue CFA site it forms four independently
Laplacian-corrected one-sided green estimates and four non-recursive quadrant
estimates. A 3x3 green-luminance structure tensor measures energy,
orientation coherence, signed-gradient coherence, and local two-level
bimodality before blending the advanced estimate with the conservative
horizontal/vertical result.

R-G and B-G interpolation uses the same local classification to combine green
distance with directional energy. Smooth ramps and periodic texture keep the
conservative path, while confident single edges receive stronger directional
selection. A gated 3x3 chroma median remains the final isolated-false-color
guard and retains the point-source protection contract.

The implementation is non-recursive and reads at most four CFA pixels beyond
an output pixel after color-difference suppression. The test suite checks
constant color, native sample preservation, vertical and diagonal edges,
smooth ramps, periodic diagonal texture, isolated chroma speckles, Gaussian
stars, cancellation, and exact independently requested tile equivalence.
