# Real Sony ARW focus-stack DNG readback

STATUS=PASS_FINAL_REAL_ANDROID_SAVE_FULL_READBACK_AND_ADOBE_RENDER
CREATED_JST=2026-08-24T23:44:00+09:00

## Source and save path

- Inputs: `real_DSC7424.ARW`, then `real_DSC7423.ARW`
- Input metadata: 6048x4024, RGGB, Sony ARW, orientation 8
- Focus-stack output: 4000x6000 Linear camera RGB
- Final Android save path: `Pictures/Mobile Stack/focus_stack_20260824_152512.dng`
- Final file size: 312132928 bytes
- Pulled file: `outputs/focus_stack_20260824_152512.dng`
- SHA-256: `D046565438C1A0A791FE61A9EC428A7E7D64E8C1FDF04D4C2103BCE97EDA5683`
- Desktop handoff copy: `C:/Users/kosuge/Desktop/app/focus_stack_20260824_152512.dng` (same SHA-256)

## Container and full-pixel readback

- Classic TIFF/DNG, little-endian, DNGVersion 1.4.0.0
- UniqueCameraModel: `MobileStack Linear sRGB`
- Main raster: 4000x6000, LinearRaw, uncompressed, chunky RGB
- BitsPerSample: 32/32/32
- SampleFormat: IEEE Float/Float/Float
- BaselineExposure: +13 EV
- RGB strips: 94
- RGB bytes: 288000000
- RGB samples scanned: 72000000 / 72000000 finite
- Negative samples: 680 (preserved scene-linear residuals)
- Above-one stored samples: 0
- Zero samples: 0
- Channel minima: -0.1714252234, 0.0613198131, 0.0538518876
- Channel maxima: 0.2590542436, 0.9017680883, 0.4996680915
- Channel means: 0.0744887761, 0.1201299515, 0.0866267433
- Transparency SubIFD: 4000x6000, 8-bit binary mask
- Main SubIFDs: LONG count 2, thumbnail first and transparency mask second
- Main NextIFD: thumbnail IFD offset 1428
- Transparency SubIFD directory offset: 1300 (header-resident)
- Transparency mask data offset: 288132928
- Valid mask pixels: 24000000
- Transparent mask pixels: 0
- Mask data ends exactly at file byte 312132928
- Embedded thumbnail: 171x256, uncompressed chunky RGB8
- Thumbnail IFD offset: 1428 (header-resident)
- Thumbnail data offset: 1600 (header-resident)
- Thumbnail bytes: 131328, sample range 0..255

The readback was performed with `tool/raw_samples/inspect_linear_dng.mjs`,
which reads the file in strips and does not materialize the 312 MB DNG or the
72-million-sample raster as one JavaScript array.

## Android scanner verification

The first saved file (`focus_stack_20260824_140218.dng`) placed the transparency
SubIFD after the 288 MB RGB raster. Android's separate FuseDaemon/ExifInterface
process tried to buffer that forward seek and logged two `OutOfMemoryError`
messages. The writer was changed so the SubIFD directory is header-resident
while its mask pixel data remains after the RGB raster.

The running app hot-reloaded 22 of 1730 libraries without losing the real
focus-stack result. After adding the bounded RGB8 thumbnail and linking it as
both the first SubIFD and main NextIFD, the final isolated save produced
`focus_stack_20260824_152512.dng`. The cleared Android log contains zero
`OutOfMemoryError`, fatal Exif, and `No image meets the size requirements of a
thumbnail image` matches. The app process survived and the full readback passed
all 72,000,000 RGB samples, 24,000,000 mask samples, and 131,328 thumbnail
bytes. The final x64 debug APK SHA-256 is
`938EAB3FE9F745FE47CCCDEF66C83151AA4AC8EC39C6EEFCBAE628279E1198A0`.

## Adobe Photoshop verification

Photoshop COM version 26.11.2 opened the final DNG and reported 4000x6000,
RGB, 8 bits/channel. This proves that Adobe accepts and decodes the container.
However, a Photoshop-generated 1000x1500 PNG was visually all white and sampled
RGB 255 at the corners, center, and quarter points. Therefore the mandatory
no-unexpected-clipping requirement is FAIL even though file readback passes.
The leading cause is the +13 EV BaselineExposure used to reverse the writer's
power-of-two placement of upstream raw numeric values. Adobe applies that EV as
rendering exposure and clips the default rendering. The PNG evidence is
`outputs/focus_stack_20260824_152512_adobe_preview.png`, SHA-256
`446CF667CA8FFC3BA9B5B199858184B489257DCC395BADE620B55F9AE24B5935`.

The production correction was then saved from the preserved real stack as
`focus_stack_20260824_160453.dng` with BaselineExposure=0. Its bytes otherwise
match the metadata-only diagnostic file exactly (SHA-256
`27AFCCCCDD1392687F8DBD5F0C52071FEE34216F80DBEF01E347FE3C20130ED5`).
Full RGB/mask/thumbnail readback passed, Android logged no OOM/fatal/thumbnail
warning, and Photoshop 26.11.2 produced a normal visible real-scene rendering.
