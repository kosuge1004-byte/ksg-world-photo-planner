# Sony RAW compatibility — Work268

Generated from the bundled LibRaw model inventory plus official ARW 6 support and hash-pinned CC0 samples. A model-list entry alone is **SAMPLE_MISSING**, not a support claim.

- LibRaw inventory candidates: 116
- VERIFIED_DECODE rows: 11
- Explicit UNSUPPORTED rows: 1
- ABI rule: a preserved, single-plane 2x2 Bayer sensor plane is required.

| Model | Mode | Bits | Crop | Status | Output |
|---|---|---:|---|---|---|
| ILCE-7M3 (A7 III) | Full-frame compressed | 14 | full-frame | VERIFIED_DECODE | 6048×4024 RGGB |
| ILCE-7M4 (A7 IV) | Full-frame uncompressed | 14 | full-frame | VERIFIED_DECODE | 7040×4688 RGGB |
| ILCE-7M4 (A7 IV) | Full-frame lossless compressed Large | 14 | full-frame | VERIFIED_DECODE | 7168×5120 RGGB |
| ILCE-7M4 (A7 IV) | Full-frame compressed | 14 | full-frame | VERIFIED_DECODE | 7040×4688 RGGB |
| ILCE-7M4 (A7 IV) | APS-C compressed | 14 | APS-C | VERIFIED_DECODE | 4736×3132 RGGB |
| ILCE-7M5 (A7 V) | APS-C compressed HQ | 14 | APS-C | VERIFIED_DECODE | 4640×3088 RGGB |
| ILCE-7M5 (A7 V) | APS-C compressed | 14 | APS-C | VERIFIED_DECODE | 4640×3088 RGGB |
| ILCE-7M5 (A7 V) | APS-C lossless compressed | 14 | APS-C | VERIFIED_DECODE | 5120×3584 RGGB |
| ILCE-7M5 (A7 V) | Full-frame compressed | 14 | full-frame | VERIFIED_DECODE | 7028×4688 RGGB |
| ILCE-7M5 (A7 V) | Full-frame compressed HQ | 14 | full-frame | VERIFIED_DECODE | 7028×4688 RGGB |
| ILCE-7M5 (A7 V) | Full-frame lossless compressed | 14 | full-frame | VERIFIED_DECODE | 7168×5120 RGGB |
| ILCE-7M4 (A7 IV) | Lossless compressed Medium | pseudo-RAW | full-frame | UNSUPPORTED | Native status 2/error 4004: not a single-plane 2x2 Bayer source. |

Known exclusion: Medium/Small YCC/pseudo-RAW modes are not treated as Bayer RAW.

See the CSV for every candidate model and the JSON manifest for hashes and numeric decode evidence.
