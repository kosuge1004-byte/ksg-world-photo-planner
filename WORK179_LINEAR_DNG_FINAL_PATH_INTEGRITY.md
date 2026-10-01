# Work179 — Linear DNG final-path integrity

Status: WIP.

## Audit result
The final Linear DNG path is intentionally 3-channel IEEE Float32 LinearRaw.
It already:
- rejects non-finite input RGB;
- applies only a linear color transform before export;
- rejects transform output outside finite Float32 range;
- preserves finite negative values;
- preserves finite values above 1.0;
- does not clamp samples to [0,1];
- writes SampleFormat=IEEE floating point and BitsPerSample=32.

This is important for retaining linear headroom and out-of-gamut intermediate
values instead of baking a display rendering into the DNG.

## Confirmed hardening
Both Classic TIFF and BigTIFF header paths now explicitly validate the projected
uncompressed image byte count before continuing with strip/header arithmetic.

A source-contract regression also locks the no-[0,1]-clamp rule in the actual
export body, so a later 'safety' edit cannot silently destroy negative/HDR
linear samples.

## Metadata audit
The writer continues to use:
- PhotometricInterpretation = LinearRaw;
- BlackLevel = [0,0,0];
- WhiteLevel = [1,1,1];
- ColorMatrix1;
- CalibrationIlluminant1 = D65;
- AsShotNeutral = [1,1,1];
- Classic TIFF / BigTIFF selection;
- optional transparency-mask SubIFD.

No metadata values were guessed or retuned in this work.

## External evidence checked
Adobe documentation confirms DNG remains a supported raw workflow in Lightroom.
The DNG/TIFF floating-point contract and LinearRaw metadata are treated here as
format constraints; compatibility still requires generating real files and
opening/validating them in the later Codex/Adobe test phase.

## Executed validation
- Node/reference/source-contract suite: 72/72 passed.
- Native clean CMake configure/build passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK and real DNG
  generation/Adobe import were not executed.
