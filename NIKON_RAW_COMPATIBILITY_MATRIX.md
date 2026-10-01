# Nikon RAW compatibility — Work268

Generated from the bundled LibRaw model inventory plus official ARW 6 support and hash-pinned CC0 samples. A model-list entry alone is **SAMPLE_MISSING**, not a support claim.

- LibRaw inventory candidates: 110
- VERIFIED_DECODE rows: 7
- Explicit UNSUPPORTED rows: 2
- ABI rule: a preserved, single-plane 2x2 Bayer sensor plane is required.

| Model | Mode | Bits | Crop | Status | Output |
|---|---|---:|---|---|---|
| D750 | Compressed | 12 | full-frame | VERIFIED_DECODE | 6032×4032 RGGB |
| D750 | Lossless compressed | 14 | full-frame | VERIFIED_DECODE | 6032×4032 RGGB |
| D800 | Compressed | 14 | full-frame | VERIFIED_DECODE | 7378×4924 RGGB |
| D800 | Uncompressed | 12 | full-frame | VERIFIED_DECODE | 7378×4924 RGGB |
| Z 8 | Lossless compressed | 14 | full-frame | VERIFIED_DECODE | 8280×5520 RGGB |
| Z f | Lossless compressed | 14 | full-frame | VERIFIED_DECODE | 6064×4040 RGGB |
| Coolpix P7000 | Standard | 12 | fixed-lens sensor | VERIFIED_DECODE | 3664×2742 RGGB |
| Z 8 | High Efficiency low | HE | full-frame | UNSUPPORTED | Native status 2/error 4007. Nikon HE/HE* is deliberately not claimed. |
| Z f | High Efficiency | HE | full-frame | UNSUPPORTED | Work268 Android x86_64 real-file rejection: native status 2/error 4007. Nikon HE/HE* is deliberately not claimed. |

Known exclusion: Nikon High Efficiency / High Efficiency* NEF is not supported by LibRaw 0.22.2.

See the CSV for every candidate model and the JSON manifest for hashes and numeric decode evidence.
