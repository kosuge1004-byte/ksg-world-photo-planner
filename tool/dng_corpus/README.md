# DNG verification corpus

This tool compares the native metadata backend with recorded reference output
without committing third-party RAW files.

Every sample must have:

- a relative path that remains inside the corpus directory
- exact byte length and lowercase SHA-256
- source, license, and redistribution status
- reference tool name, version, command, and timestamp
- expected dimensions, CFA, active area, orientation, levels, and camera WB

The runtime validator is intentionally stricter than a plain JSON parse. It
rejects unknown fields, duplicate IDs, path traversal, symlinks escaping the
corpus directory, invalid image geometry, inconsistent levels, hash mismatch,
and files that differ from the recorded byte length.

## Prepare a private corpus

Create a directory outside the repository or under `tool/dng_corpus/files/`.
Files placed in the latter location are ignored by Git. Keep a
`manifest.json` next to its `files/` directory and follow
`manifest.schema.json`. `manifest.template.json` is a structural example only;
replace every placeholder, size, hash, and expected value before use.

Do not mark a sample redistributable unless its license explicitly permits
redistribution. A `false` value is valid and documents that the file must stay
local.

## Inventory candidate files

Before writing a manifest, create a deterministic draft inventory of a private
DNG directory:

```sh
node tool/dng_corpus/inventory_dng_corpus.mjs \
  --directory /path/to/private-dng-files \
  --output /path/to/inventory.json \
  --max-files 1000
```

The tool recursively finds case-insensitive `.dng` files without following
symbolic links. It sorts paths deterministically, streams SHA-256, checks that
each regular file did not change during hashing, and records only a safe ID
suggestion, relative path, exact byte length, and digest. The default file
limit is 1000 and the accepted range is 1 through 10000.

The output follows `inventory.schema.json`, has `status: "draft"`, is created
atomically, and never replaces an existing file. Ctrl+C and `SIGTERM` cancel
hashing and publish no inventory. It contains neither DNG bytes nor absolute
paths.

An inventory is intentionally not a verification manifest and the verifier
rejects it. Copy the mechanical fields into `manifest.template.json`, then
manually record provenance, license, redistribution status, the exact
reference-tool invocation, and independently measured expected metadata.
Inventory generation does not inspect DNG structure and does not prove that a
candidate is valid, licensed, or camera-originated.

Create an authoring draft from a reviewed inventory:

```sh
node tool/dng_corpus/create_manifest_draft.mjs \
  --inventory /path/to/inventory.json \
  --output /path/to/manifest-draft.json \
  --corpus-id mobile-stack-private-dng
```

The CLI strictly revalidates the inventory contract, rejects symbolic-link,
invalid UTF-8, invalid JSON, changed, tampered, or larger-than-10-MiB inventory
inputs, and records the SHA-256 of the exact inventory bytes. It carries the
mechanical sample fields into the format described by
`manifest-draft.schema.json`.

Every generated draft has `status: "incomplete"`. Its `provenance`,
`reference`, and `expected` blocks are `null` until a person supplies and
reviews them. The draft is structurally distinct from `manifest.json` and the
verifier rejects it even after the blocks are populated.

After manually filling every block, finalize it against the exact inventory
and current DNG files:

```sh
node tool/dng_corpus/finalize_manifest.mjs \
  --draft /path/to/manifest-draft.json \
  --inventory /path/to/inventory.json \
  --directory /path/to/private-dng-files \
  --output /path/to/manifest.json
```

The finalizer rejects null or invalid review blocks, draft/inventory mechanical
field differences, an inventory whose exact bytes no longer match the hash
pinned by the draft, and any DNG path containing a symbolic link. It rechecks
every DNG byte length and streamed SHA-256 and detects changes during hashing.
Only then does it atomically create a strict verifier manifest without
overwriting an existing file.

This gate proves internal consistency, not the truth of manually entered
evidence. A person remains responsible for the provenance, license,
redistribution decision, reference command, and expected metadata.

## Build and verify

```sh
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --config Release
node tool/dng_corpus/verify_dng_corpus.mjs \
  --manifest /path/to/corpus/manifest.json \
  --probe build/native/mobile_stack_dng_probe_cli \
  --jobs 4 \
  --repeat 3 \
  --timeout-ms 30000 \
  --report /path/to/reports/verification.json
```

On Windows, use the generated `.exe` path. On macOS and Linux, the build
directory must be able to locate the adjacent `mobile_stack_raw` shared
library, which the CMake build configures for its own executables.

`--jobs` accepts 1 through 8 concurrent probe processes and defaults to 1.
`--repeat` accepts 1 through 100 runs per sample and defaults to 1. Logs and
report runs always follow manifest order and then repetition order, regardless
of the order in which concurrent processes finish.

`--timeout-ms` accepts 100 through 300000 milliseconds per native process and
defaults to 30000. A timeout terminates the process and fails the verification.
The first timeout, process error, or metadata mismatch stops new scheduling
and cancels native processes that are already active.

Ctrl+C (`SIGINT`) and `SIGTERM` use the same cancellation path. The verifier
stops streamed hashing or new scheduling, terminates active native processes,
waits for their exit, and publishes no report. The CLI returns conventional
exit code 130 for `SIGINT` and 143 for `SIGTERM`.

`--report` is optional. The verifier writes the versioned format described by
`verification-report.schema.json` only after every requested run passes. The
report is created atomically in its destination directory and refuses to
replace an existing file. A failed or mismatched run never publishes a final
report. Choose a new report path for every audit rather than deleting prior
evidence.

The native CLI emits one JSON object and never reads pixel strips. The Node
verifier hashes each file once as a stream before starting probes, invokes the
CLI without a shell, caps captured process output at 1 MiB, and reports each
field mismatch. Hashing, native execution, and report publication share one
caller-controlled cancellation signal. The recorded reference command is audit
text only and is never executed by the verifier.
