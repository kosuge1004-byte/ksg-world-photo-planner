# Claude sandbox checkpoint 1 reconciliation

Reviewed in the Codex-capable workspace on 2026-08-24 JST.

- Source: `mobile-stack-claude-sandbox-checkpoint1.zip`
- SHA-256: `78F04FEECB6A629D5CA919CE88733BC61977DB620C69C8D6578060A024A27A42`
- Claude base: Codex Work224 checkpoint 61
- Current base at reconciliation: Codex Work224 checkpoint 79

The archive's in-place legacy full-frame blend could not be copied wholesale:
checkpoint 79 had already removed the production all-frame aligned-RGB list and
full-resolution weight plane, replacing them with file-backed focus scores and
tile-by-tile registered blending. Restoring the checkpoint-61 path would have
reintroduced the larger peak that the later work eliminated.

The value-preserving part of Claude's change was carried forward into the
current production path instead. `blendAlignedFocusFramesMemoryBounded` now
writes each blended tile into frame zero's already-owned RGB and coverage
buffers after consuming that pixel. This removes one additional tile-sized RGB
and coverage allocation. A direct Dart comparison of the materialized-weight
reference and the reused-buffer implementation passed 500/500 deterministic
random trials covering 98,549 pixels bit exactly. The output-buffer identity is
also pinned by a Flutter regression test; that test remains not run because the
Flutter SDK lockfile is outside the writable sandbox. Direct Dart analysis and
the complete 613-test Node suite pass.

The archive's stale `decodedFrames.first` source-contract fix was already
present in checkpoint 79 and required no further change.
