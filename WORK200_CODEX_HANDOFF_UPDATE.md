# Codex handoff update after Work200

Use Work200 as the latest baseline, superseding Work199 and older Codex-first ZIPs.

Before any new implementation, Codex must:
1. Read WORK200_DNG_SPEC_COMPLIANCE_AUDIT.md.
2. Run the existing Work187/updated preflight with Flutter 3.44.7.
3. Run flutter pub get, flutter analyze, flutter test, Android arm64 APK build and ABI verification.
4. Do not revert DNGBackwardVersion from 1.4.0.0 to 1.1.0.0.
5. Do not revert ColorimetricReference from scene-referred (0) to output-referred (1) unless a DNG-spec/Adobe-reader test proves the current scene-referred contract is wrong.
6. Specifically validate the OPEN issue: finite positive Linear DNG samples >1.0 versus DNG reader clipping semantics. Do not 'fix' it by blind clipping.
7. Preserve maximum image quality and do not weaken tests to make them pass.

Required result evidence remains WORK187_CODEX_RESULTS.md / work187_logs or a newer equivalent.
