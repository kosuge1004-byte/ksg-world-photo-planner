# Work244 - ILCE-7M3 uncompressed ARW support

## Evidence
The supplied DSC05609.ARW contains `SONY`, model `ILCE-7M3`, and its full-resolution CFA IFD is 6048x4024, 14-bit, Compression=1, PhotometricInterpretation=32803. StripByteCounts is 48,674,304 bytes, exactly 6048*4024*2.

Sony documentation confirms ILCE-7M3 supports uncompressed RAW and 14-bit RAW.

## Root cause
Work243 native ARW decode accepted only Compression=7 JPEG Lossless and Compression=32767 Sony ARW2. Therefore this actual file was rejected before mode-specific stacking. This explains the same all-file failure in Milky Way and star-trail modes when the selected frames share this RAW recording format.

## Fix
Added Compression=1 uncompressed CFA strip support. Samples are read as TIFF-endian 16-bit words, range checked against BitsPerSample, and copied unchanged to FP32 sensor values. No black subtraction, WB, gamma, demosaic, or quality-reducing transform is performed in decode.

## Actual-file verification
The patched native decoder successfully decoded the supplied DSC05609.ARW: status=OK, 6048x4024, 24,337,152 samples, white level 16383.

The user's ARW is not bundled in the project ZIP.
