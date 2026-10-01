# Work166 — Linear DNG geometry/crop compatibility

Status: WIP.

## Evidence-driven change
The DNG specification defines ActiveArea as the non-masked sensor/image area,
DefaultCropOrigin relative to ActiveArea, and DefaultCropSize as the final raw
image area. Adobe's DNG SDK writer emits DefaultCropOrigin and DefaultCropSize
for the raw IFD.

This app's Linear DNG is a synthesized stack raster. It has no preserved hidden
sensor-border pixels. Therefore the only non-invented geometry is:
- ActiveArea = [0, 0, height, width]
- DefaultCropOrigin = [0, 0]
- DefaultCropSize = [width, height]

## Implemented
Classic and 64-bit DNG writers now explicitly emit:
- 50719 DefaultCropOrigin, RATIONAL[2] = 0/1, 0/1
- 50720 DefaultCropSize, RATIONAL[2] = width/1, height/1
- 50829 ActiveArea, LONG[4] = 0, 0, height, width

No MaskedAreas tag is invented because the synthesized output does not retain
a known optical-black sensor border. Invalid stack support remains represented
by the Work163-165 Transparency Mask SubIFD instead.

## Preserved
- Float32 LinearRaw samples unchanged.
- No tone/gamma/exposure bake-in added.
- Work165 SubIFD transparency linkage unchanged.
- Normal-stack and CFA-Drizzle validity semantics unchanged.

## Executed validation
- Node/reference/source-contract suite: 423/423 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.

## Remaining limits
- Flutter/Dart SDK unavailable in this environment: Dart compile/analyze,
  Flutter tests and APK build remain unexecuted.
- Adobe DNG Validator and Lightroom/Camera Raw loading of an actual
  app-generated Work166 DNG remain unexecuted.
