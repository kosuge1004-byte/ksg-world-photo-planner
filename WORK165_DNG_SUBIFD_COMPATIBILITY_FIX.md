# Work165 — DNG Transparency Mask SubIFD compatibility fix

Status: WIP.

## Critical compatibility issue found
Work163/164 connected the Transparency Mask through the main TIFF NextIFD
chain. That is valid multi-image TIFF structure, but it is not the DNG layout
used by Adobe's DNG writer. Adobe DNG SDK writes transparency masks as SubIFDs
(tag 330), and its validator warns that chained IFDs are ignored by DNG
readers.

## Implemented
- Removed main-IFD chained linkage for Transparency Mask.
- Classic DNG:
  - main IFD contains SubIFDs tag 330
  - SubIFDs type = TIFF_IFD (13)
  - count = 1
  - value points to Transparency Mask IFD
  - main NextIFD remains 0
- 64-bit DNG / BigTIFF:
  - main IFD contains SubIFDs tag 330
  - SubIFDs type = TIFF_IFD8 (18)
  - count = 1
  - 64-bit value points to Transparency Mask IFD
  - main NextIFD remains 0
- Transparency Mask IFD itself still uses:
  - NewSubFileType = 4
  - PhotometricInterpretation = 4
  - SamplesPerPixel = 1
  - BitsPerSample = 8
  - Compression = none
- Existing normal-stack and CFA-Drizzle validity-mask generation is unchanged.
- Classic-vs-BigTIFF sizing logic remains unchanged.

## Independent structure validation
`tifffile` parses both reference containers as:
- one main IFD
- one SubIFD
- mask data read back exactly as `[255, 0, 255, 0]`
- no parser warnings

Classic:
- SubIFDs tag present
- mask SubIFD recognized
- main chained NextIFD is zero

BigTIFF:
- SubIFDs tag present
- mask SubIFD recognized
- IFD8 offset is 64-bit and aligned
- main chained NextIFD is zero

## Executed validation
- Node/reference suite: 421/421 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Independent Classic SubIFD parser validation: passed.
- Independent BigTIFF SubIFD parser validation: passed.
- Regression prevents reintroduction of `nextIfdPointerOffset`.

## Remaining limits
- Flutter/Dart SDK unavailable: no Dart compile/analyze/Flutter tests/APK build.
- Lightroom / Camera Raw interoperability with an actual app-generated Work165
  DNG remains unverified.
