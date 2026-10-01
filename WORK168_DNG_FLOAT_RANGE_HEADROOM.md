# Work168 — Float32 Linear DNG range/headroom semantics

Status: WIP.

## Evidence
DNG specifies WhiteLevel default = 1.0 for floating-point raw images.
BlackLevel defaults to zero. The DNG processing model normalizes using these
levels. BaselineExposure defaults to 0 EV and is a default-render exposure
zero-point adjustment, not additional source data.

## Implemented
For both Classic and 64-bit Linear DNG:
- BlackLevel (50714) explicitly written as DOUBLE[3] = [0,0,0].
- WhiteLevel (50717) explicitly written as DOUBLE[3] = [1,1,1].
- BaselineExposure remains omitted, therefore specification default = 0 EV.
- DefaultBlackRender remains None.
- No LinearizationTable is added.

## Quality-preserving sample policy
The Float32 raster writer remains intentionally unclipped:
- finite negative linear values are preserved;
- finite values above 1.0 are preserved as highlight/headroom information;
- NaN and infinity are rejected;
- values outside finite Float32 range are rejected.

WhiteLevel=1.0 identifies the nominal fully-saturated/reference-white encoding
level for DNG normalization. It is not used here as a destructive clamp during
serialization.

This is preferable to clipping the stack to [0,1], which would irreversibly
discard negative reconstruction residuals and >1 linear highlight values before
the RAW editor sees them.

## Executed validation
- Node/reference/source-contract suite: 428/428 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Regression explicitly prevents adding a [0,1] clamp to the DNG sample writer.

## Still unverified
- Dart/Flutter compile/analyze/tests/APK.
- Adobe DNG Validator.
- Whether Lightroom/Camera Raw preserves useful editability of >1 and negative
  Float32 samples in an actual Work168 file. That requires application-level
  interoperability testing and is not claimed here.
