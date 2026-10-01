# Adobe DNG readback report

STATUS=PASS_REAL_ANDROID_SAVE_AND_PHOTOSHOP_RENDER
CREATED_JST=2026-08-25T00:49:00+09:00

- Input: `outputs/focus_stack_20260824_152512.dng`
- Input SHA-256: `D046565438C1A0A791FE61A9EC428A7E7D64E8C1FDF04D4C2103BCE97EDA5683`
- Reader: Adobe Photoshop COM 26.11.2
- Open/decode: PASS
- Adobe document: 4000x6000, RGB, 8 bits/channel
- Window title: `focus_stack_20260824_152512.dng @ 12.5% (layer 0, RGB/8*)`
- Adobe PNG export: PASS, 1000x1500
- PNG SHA-256: `446CF667CA8FFC3BA9B5B199858184B489257DCC395BADE620B55F9AE24B5935`
- Default-render visual result: FAIL, all-white RGB
- Five sampled points: R=255, G=255, B=255
- Alpha: 255 in the interior, 220 at sampled top-left/bottom-right border points

The DNG container, all Float32 samples, mask, and embedded thumbnail remain
valid. The failure is specifically Adobe's default rendering. The current file
declares BaselineExposure=+13 EV after dividing upstream numeric samples by
8192 for Float LinearRaw placement; Adobe reconstructs that as display exposure
and clips the image. Do not mark the external-reader check PASS until a newly
saved real DNG produces a non-clipped Adobe rendering.

## Production fix verification

The production writer now keeps BaselineExposure neutral. After hot reload, the
preserved real stack saved `focus_stack_20260824_160453.dng` through Android
MediaStore. The 312132928-byte file has SHA-256
`27AFCCCCDD1392687F8DBD5F0C52071FEE34216F80DBEF01E347FE3C20130ED5` and
BaselineExposure=0. Full streaming readback passed every RGB, mask, and
thumbnail byte; isolated Android logs contain zero OOM, fatal, or missing
thumbnail-candidate matches.

Photoshop 26.11.2 opened the production file as 4000x6000 RGB8 and exported a
normal visible 1000x1500 rendering of the real scene. The preview is
`outputs/focus_stack_20260824_160453_adobe_preview.png`, SHA-256
`6277895B73FBEFD84E10DAF724E7F49F151E5735A24803C5781A5BD63DF8FFAE`.
The Adobe default-render clipping failure is fixed.
