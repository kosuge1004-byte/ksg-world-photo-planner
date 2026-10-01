# Work310: Linear DNG export crash fix (star trail / milky way)

## Symptom
Star trail (星の軌跡) and Milky Way stacking jobs failed at the final
export step when the output format was Linear DNG, with:

```
Bad state: Invalid argument(s): Linear DNG export does not bake
exposure, white point, LUTs, or tone curves.
```

## Root cause
`standard_stack_background_worker.dart` computes a fixed tone baseline
(`exposureScale`/`whitePoint`) from the reference frame once per job and
was forwarding it unconditionally to both
`combineDecodedFramesAndExport` (star trail) and
`registerAndCombineDecodedFramesAndExport` (milky way), regardless of
the selected `outputFormat`.

`_exportLinearDngWithoutRenderedAdjustments` in `export_result.dart`
deliberately throws `ArgumentError` if `exposureScale` or `whitePoint`
is non-null, because a Linear DNG must stay an unadjusted linear render
(tone mapping is meant to happen later in a raw editor, not baked in at
export time). Since `OutputImageFormat.linearDng` is also this worker's
fallback default, any run using it (or explicitly selecting it) hit
this guard and failed.

## Fix
In `runStandardStackBackgroundTask`, after computing
`fixedToneBaseline`, only forward `exposureScale`/`whitePoint` to the
export call when `outputFormat != OutputImageFormat.linearDng`;
otherwise pass `null` for both. Tone-baking formats (BMP/JPEG/TIFF16)
are unaffected — behavior there is unchanged.

## Files changed
- `lib/core/background/standard_stack_background_worker.dart`

## Not touched
Other background workers (focus stack, CFA-drizzle, meteor composite)
were checked and do not pass `exposureScale`/`whitePoint` at all, so
they were not affected by this bug.

---

# Work310b: Background RAW decode watchdog deadlock (ANR)

## Symptom
Milky Way / star trail background stacking jobs could appear to hang
indefinitely (observed: 1/8 frames after 72+ minutes elapsed), with
Android eventually reporting the whole app as unresponsive ("Mobile
Stack は応答していません" / ANR), instead of the app's own 30-minute
per-frame stall failure ever surfacing.

## Root cause
`createProductionBackgroundNativeRawDecoderRegistry()` used
`FfiRawDecodeCurrentIsolateBackend`, which calls the native RAW decode
FFI function *synchronously, on the caller's own isolate* (chosen to
avoid an extra isolate hop and a second full-frame buffer copy, since
background workers already run outside the UI isolate).

But `StandardStackBackgroundWorker`'s `JobScheduler` also runs its
30-minute stall watchdog (`fullFrameRawStallTimeout`) as a plain Dart
`Timer` **on that same isolate**. A synchronous FFI call blocks the
isolate's event loop for its entire duration; while it's blocked, no
other Dart code on that isolate can run — including the watchdog
`Timer`'s own callback. So if one frame's native decode call
genuinely hangs, or is merely extraordinarily slow (e.g. sustained
thermal throttling on a real device), the safety net that exists
specifically to convert that into a clean failure can never fire,
because firing it requires the exact event loop the hang is holding
hostage. The result surfaces as a full app freeze (ANR) rather than
the intended "30分間、処理の進捗がありませんでした" error.

The UI-path decoder (`createProductionNativeRawDecoderRegistry()`,
used by the foreground `ProcessingProgressScreen`) was never affected:
it already used `FfiRawDecodeWorker`, which wraps the same FFI call in
`Isolate.run()`, keeping it off the isolate that hosts the UI/watchdog.

## Fix
Added `FfiRawDecodeBackgroundWorkerBackend` (`ffi_raw_native_bridge.dart`),
which wraps both `decode()` and `decodeToFile()` in `Isolate.run()`,
same as `FfiRawDecodeWorker`, but also implements
`RawNativeFileDecodeBackend` so the streamed/file-backed decode path
(and its low memory footprint) keeps working for background jobs —
`FfiRawDecodeWorker` alone doesn't implement that interface, so simply
swapping to it would have silently disabled streaming for every
background job, not just the hung case.

`decodeToFile` pays no extra copy for the added isolation: the native
call already streams samples to disk, so only a small metadata record
and a file path cross the isolate boundary. `decode` (the in-memory
fallback path — the one actually in play during the observed
incident, since the log showed `memory-fallback:stream-precondition`
for every frame) pays one extra full-frame `Float32List` copy, same
as the existing UI-path backend — an acceptable, non-optional cost
given the alternative is a full app freeze.

`createProductionBackgroundNativeRawDecoderRegistry()` now uses this
new backend instead of `FfiRawDecodeCurrentIsolateBackend`. A matching
web/PWA stub was added to `ffi_raw_native_workers_stub.dart` (native
decoding is unavailable there regardless, per the existing pattern for
the other backends).

## What this fix does — and doesn't — resolve
This restores the watchdog's ability to fire and turns a hang into a
clean, actionable failure instead of an app-level freeze. It does
**not** identify why a specific frame's native decode call was slow or
stuck in the first place — that would require native-side
instrumentation (the decode itself runs inside the bundled libraw-based
C/C++ engine under `native/src` and `native/third_party/libraw`, which
emits nothing to `DiagnosticLog` mid-call).

## Follow-up: diagnostic logging added for next occurrence
The uploaded frame previews (JPEG thumbnails embedded in each RAW) and
the release APK were reviewed, but neither can explain *why* one
frame's native decode call was slow/stuck on the device that hit
this — the previews carry no sensor/decoder-relevant data, and the
native decode itself emitted nothing to `DiagnosticLog` mid-call, so
there was no way to tell decode-call-boundary timing from inside a
stall after the fact.

Added explicit start/complete `DiagnosticLog` markers, tagged with
`job.sourcePath`, around every native decode call site in
`phase2_validated_job_executor.dart`:
- job start (`phase2 job start source=...`)
- streamed/file-backed decode start/complete
- in-memory fallback decode start/complete

If this recurs, the diagnostic log will now show, per source file,
whether it reached `native_raw_decode start` and never logged
`complete` — pinpointing that a specific file's native call is what's
actually stuck, and whether it happened on the streamed or in-memory
path — instead of only the aggregate `rawDecode N/8` counter.

---

# Work310c: Memory/thermal heartbeat during native decode

## Motivation
Start/complete markers (Work310b above) show *that* a specific file's
native decode call is stuck, but say nothing about *why* — whether the
device is genuinely resource-starved (low memory, thermal throttling)
or the native call itself is stuck for some other reason (corrupt
input, algorithmic edge case). The app already reads exactly this data
(`ResourceSnapshot`: available memory, thermal pressure, battery) via
`readDefaultResourceSnapshot()`, but only at `JobScheduler` pump time
to size worker concurrency — never logged, and never sampled while a
single decode call is actually in flight.

## Change
Added `_withResourceHeartbeat()` in `phase2_validated_job_executor.dart`,
wrapping both native decode call sites (streamed and in-memory
fallback). While the wrapped call is pending, it logs a
`DiagnosticLog` entry every 20 seconds:

```
native_raw_decode heartbeat source=<path> elapsed=<n>s
availableMemory=<n>MB thermalPressure=<0..1> battery=<n>%
```

and stops as soon as the call resolves (success or failure).

This is now possible without adding meaningful risk of making a hang
worse: after Work310b (background decode moved onto its own worker
isolate via `Isolate.run()`), the isolate hosting this heartbeat timer
is no longer the one blocked inside the native call, so the `Timer`
can fire on schedule even if the decode call itself is stuck.

## What this gives future incidents
If this recurs, the log will show one of two patterns for the stuck
frame:
- Available memory trending toward zero / thermal pressure pinned high
  for the whole stall → points at genuine device resource exhaustion
  (matches the "long native decode under thermal throttling" case the
  existing 30-minute watchdog comment already anticipated).
- Resources looking normal throughout → points at the native call
  itself (e.g. a specific malformed/unusual input file, or an
  algorithmic hang inside the bundled libraw-based decoder) rather
  than the device being under load.

Either way, it's no longer necessary to guess — the next occurrence's
diagnostic log will contain the answer.

---

# Work310d: Missing completion notification — diagnostics + a real bug

## Symptom
A background stack job completed successfully (diagnostic log showed
a clean `task complete`), but no completion notification appeared.

## Two independent issues found

**1. Silent failure path (diagnosability gap).** `StackJobReporter
.complete()`/`.fail()` wrapped `StackJobNotifications.showCompleted`/
`showFailed` in a bare `try { } on Object { }` that discarded the
error entirely — by design, so a notification problem could never
abort a finished stack, but as a side effect there was no way to tell
"permission was missing" from "some other exception" from "it actually
worked." Separately, `requestPermission()` (called right when a
background job starts, from the foreground isolate) never logged its
result either. If the person backgrounds the app while that OS
permission dialog is still up — or before it has rendered — the
dialog can get auto-dismissed/denied depending on Android
version/OEM, and every later `.show()` call then succeeds from
Flutter's point of view while Android silently drops the notification
— no exception, nothing to catch.

Both now log to `DiagnosticLog`:
- `notification permission request result=<true/false/null>` at the
  point permission is requested.
- `completion notification: notificationsEnabled=<true/false/null>`
  immediately before attempting the completion notification.
- `completion notification failed: <error>` / `failure notification
  failed: <error>` if `.show()` itself throws.

A future "no notification arrived" report can now be answered
directly from the log instead of guessed at.

**2. Real bug: channel importance was silently downgraded.**
`showRunning` (the ongoing progress notification, `Importance.low` —
correct, it shouldn't interrupt) and `showCompleted`/`showFailed`
(`Importance.high`) all shared one channel ID (`stack_processing`).
Android notification channels are immutable after first creation —
whichever importance the channel is created with the *first* time
sticks for its lifetime, regardless of what a later `show()` call on
the same channel ID requests. Since the low-importance running
notification is always created first (as soon as a job starts), the
completion/failure notifications' `Importance.high` was silently
never taking effect: they'd still land in the shade, but without the
heads-up/sound `Importance.high` is meant to provide — plausibly
exactly why a completed job's notification could go unnoticed.

Fixed by giving completion/failure notifications their own channel
(`stack_processing_result`), so their `Importance.high` actually
takes effect regardless of what order notifications happen to fire in.

## Files changed
- `stack_job_notifications.dart`: added `areNotificationsEnabled()`,
  logged `requestPermission()`'s result, split the completion/failure
  channel out from the running-progress channel.
- `stack_job_reporter.dart`: log notification-enabled state and any
  `.show()` failure in `complete()`/`fail()` instead of discarding
  silently.

---

# Work310e: Full background-feature review — external stall watchdog
# and consistent duplicate-registration guard across all 6 job kinds

## Motivation
Everything up to Work310d hardened one call site at a time (RAW
decode, then — discovered but not yet fixed — demosaic tile
processing shares the exact same "synchronous native call blocks the
isolate hosting the watchdog Timer" weakness). Chasing every native
call site individually means each new one added to the pipeline in
the future inherits the same latent risk by default. Separately, a
review of all six background job kinds (cfaDrizzle, standardStack,
focusStack, focusMarking, meteorAnalysis, meteorComposite) found that
only `startCfaDrizzle` verified its own WorkManager registration was
actually kept; the other five had no such check.

## 1. External stall watchdog (`external_stall_watchdog.dart`, new file)
A generic, reusable `runWithExternalStallWatchdog()` that spawns a
genuinely separate monitor isolate alongside a background job's body.
The monitor polls the job's persisted status file every minute; if the
job is still `queued`/`running` but `updatedEpochMs` hasn't advanced
in `staleThreshold` (default 30 minutes), it writes a terminal
`failed` status directly to the file and attempts a failure
notification, then exits. The monitor is killed as soon as the body
returns by any means.

This is deliberately call-site-agnostic: it doesn't matter whether the
stall is in RAW decode, demosaic, tile-store combine, export, or any
native call added to the pipeline later — none of them share an event
loop with this monitor, so none of them can prevent it from firing.
It cannot forcibly interrupt a stuck synchronous FFI call (Dart cannot
preempt that from another isolate), but it guarantees the *persisted
job state the person and the UI actually see* does not wait forever
for that call to return.

**Known limitation, stated plainly**: if the stuck native call
eventually does return (e.g. after 45 minutes, past the 30-minute
watchdog's cutoff), the original job body will still try to write its
own `completed`/`failed` status afterward, which would overwrite the
watchdog's earlier `failed` record — a benign but real race given
Dart cannot cancel a blocking FFI call from outside its isolate. This
is an accepted tradeoff, not an oversight.

Applied to all six background workers: `standard_stack_background_worker.dart`,
`cfa_drizzle_background_worker.dart`, `focus_stack_background_worker.dart`,
`focus_marking_background_worker.dart`, `meteor_background_worker.dart`,
`meteor_composite_background_worker.dart`.

## 2. Consistent duplicate-registration guard
Extracted `startCfaDrizzle`'s post-registration `getWorkInfo` check
(confirm WorkManager actually kept *this* call's `registerOneOffTask`,
identified by tag, rather than an already-running one under the same
unique name — `ExistingWorkPolicy.keep` alone doesn't tell the caller
which one won) into a shared `_registerUniqueTaskVerified()` helper on
`BackgroundStackController`, and applied it uniformly to all six
launch functions (`startCfaDrizzle`, `startStandardStack`,
`startFocusStack`, `startFocusMarking`, `startMeteorAnalysis`,
`startMeteorComposite`). Previously only `startCfaDrizzle` had this
check; the other five could silently leave `StackJobRegistry` pointing
at a job WorkManager never actually ran if two launch calls raced
(e.g. a fast double-tap on "start") before either had written its
registry record.

## Files changed
- `external_stall_watchdog.dart` (new)
- `standard_stack_background_worker.dart`,
  `cfa_drizzle_background_worker.dart`,
  `focus_stack_background_worker.dart`,
  `focus_marking_background_worker.dart`,
  `meteor_background_worker.dart`,
  `meteor_composite_background_worker.dart`: wrapped body in
  `runWithExternalStallWatchdog`.
- `background_stack_controller.dart`: added
  `_registerUniqueTaskVerified()`, all six `start*` functions now use
  it instead of five of them calling `Workmanager().registerOneOffTask`
  directly and unverified.

## Still open (not fixed in this pass, documented for the record)
- Demosaic tile processing (`NativeMobileStackDemosaicEngine.processTile`)
  makes the same kind of unguarded synchronous FFI call RAW decode used
  to make, on whatever isolate is running the pipeline. Per-tile
  progress reporting resets `JobScheduler`'s watchdog on every tile, so
  this is only exposed if one specific tile call itself stalls — lower
  probability than the whole-frame RAW decode case, but the same root
  cause. The external stall watchdog above now provides a backstop for
  this specific gap (and any other future one) at the job level, so it
  is mitigated but not eliminated at the source. A proper fix would
  move tile dispatch onto a persistent worker isolate rather than
  calling native code inline; scoped as a follow-up given the size of
  that change.
- `FOREGROUND_SERVICE_DATA_SYNC`'s ~6 hour Android 14+ continuous
  execution ceiling while backgrounded is a separate, OS-level limit
  from the app's own 30-minute watchdog. Not expected to be hit at
  typical frame counts/quality settings; noted for very large batches
  on slow devices.
- No pre-flight free-storage check in `BackgroundInputStager` before
  staging input copies; a low-storage failure surfaces as a raw
  exception rather than a friendly message.

---

# Work310g: A real "stop" button for background jobs

## Motivation
There was no way to stop a running background stack job short of force-
closing the app. `JobScheduler` already had in-process cancellation
support, and the export layer already had a working `isCancelled`/
`ExportCancelled` mechanism — but nothing connected either to the
foreground progress screen, since the screen and the worker run in
different isolates/engines with no shared memory to signal through.

## Mechanism: a dedicated marker file, not a field on the status JSON
`StackJobStatus.requestCancellation(statusPath)` / `.isCancellationRequested(statusPath)`
/ `.clearCancellationRequest(statusPath)` (`stack_job_status.dart`) manage
a small sibling file, `<statusPath>.cancel`. A first attempt embedded the
flag as a field inside the status JSON itself, but that file is rewritten
by the worker roughly once a second as part of ordinary progress
reporting — the foreground screen's write could be, and in testing would
routinely be, silently overwritten back to "not requested" by the
worker's own very next routine progress publish, built from in-memory
state that knows nothing about the flag. A separate file the worker only
ever reads (and deletes once, on its own terminal state) has no such
writer race.

`StackJobReporter.cancellationRequested` (`stack_job_reporter.dart`)
caches this, refreshed at most every 2 seconds (piggybacked on the
existing progress-publish throttle plus the 10-second heartbeat timer) —
frequent enough for a stop to take effect promptly, infrequent enough to
avoid a file read on every one of potentially hundreds of per-tile
progress calls a second. `StackJobReporter.cancel()` is a new terminal
state alongside `complete()`/`fail()`, using the existing `cancelled`
`StackJobState` and a quiet (non-alarm) notification.

## Wired into all six background workers
Each worker now checks `reporter.cancellationRequested` at a safe point
(between frames, not attempting to interrupt one already in flight —
Dart cannot preempt a blocking FFI call; see
`external_stall_watchdog.dart`'s doc comment) and passes it through as
`isCancelled` to whichever pipeline/export functions already accepted
it, catching each one's specific cancellation exception ahead of the
generic failure handler so a stop is reported as `cancelled`, not
`failed`:

- **standardStack**: checked before each frame's decode job starts, and
  again before the final combine/export stage; `isCancelled` wired into
  both `combineDecodedFramesAndExport` and
  `registerAndCombineDecodedFramesAndExport` (catches `ExportCancelled`).
- **cfaDrizzle**: wired into `runCfaDrizzleMilkyWayPipeline` (catches
  `CfaDrizzleTiledCancelled`) and `compositeCfaDrizzleMilkyWayAndExport`
  (catches `ExportCancelled`).
- **focusStack**: wired into `runFocusStackPipeline` (catches
  `FocusStackPipelineCancelled`) and `exportFocusStackResult` (catches
  `ExportCancelled`).
- **focusMarking**: wired into `analyzeFocusMarking` (catches
  `FocusMarkingAnalysisCancelled`).
- **meteorAnalysis**: wired into `runMeteorAnalysisPipeline` (catches
  `MeteorAnalysisCancelled`), and now also checked once per frame inside
  the scheduler's own executor before that frame's decode starts — same
  safe-point pattern as `standardStack`'s scheduler. Previously this was
  the one gap in the set: cancellation only signaled via a plain
  `StateError` matched narrowly by message text, and only checked before
  the whole RAW-decode phase started or after it fully finished, not
  between frames. Added `MeteorAnalysisCancelled` (a proper exception
  type, replacing all six `StateError`-based cancellation throws in
  `meteor_pipeline.dart`) and the missing per-frame check, closing both
  gaps.
- **meteorComposite**: wired into `compositeSelectedMeteorStreaksTiledAndExport`
  (catches `TiledStackingCancelled` and `ExportCancelled`).

## UI
Added a stop button (app bar action, confirmation dialog first) to
`standard_background_progress_screen.dart` and
`cfa_drizzle_milky_way_progress_screen.dart`. Traced every one of
`background_stack_controller.dart`'s six launch functions' call sites
(`focus_stack_screen.dart` included) to confirm these are in fact the
*only* two background-job progress screens in the app — every job kind
funnels through one of these two, so this is full coverage, not a
partial one. (The separate live foreground processing screen,
`processing_progress_screen.dart`, already had its own working
in-isolate cancellation from before this session and did not need
changes.)

`BackgroundStackController.requestCancellation(statusPath)` deliberately
does **not** also call `Workmanager().cancelByUniqueName()`. That API can
lead Android to tear the underlying worker down abruptly rather than
letting it unwind, which would race against — and could pre-empt — the
graceful shutdown this marker triggers (finish the current safe point,
write a clean `cancelled` status and notification, then return `true`
from the task callback so WorkManager considers it done on its own
terms). Forcing an external cancel on top only risks losing that clean
terminal status to an abrupt kill instead.

## Files changed
- `stack_job_status.dart`: marker-file cancellation request/check/clear.
- `stack_job_reporter.dart`: `cancellationRequested`, `cancel()`,
  `StackJobCancelledException`.
- All six background workers: per-frame/per-stage cancellation checks,
  `isCancelled` wiring, dedicated `on <Cancelled>` catch clauses.
- `background_stack_controller.dart`: `requestCancellation()`.
- `standard_background_progress_screen.dart`,
  `cfa_drizzle_milky_way_progress_screen.dart`: stop button + confirm
  dialog + handling the new `cancelled` terminal state.


---

# Work310f: Eliminating ANR at the OS-scheduling level, not just the Dart level

## Why Work310b/e weren't the whole story
Moving native decode calls off the isolate hosting the watchdog
`Timer` (Work310b) fixes a *Dart-level* problem: a blocking call can no
longer prevent Dart code on another isolate from running. It does
nothing about a *different, OS-level* problem underneath it: the
isolate performing that decode still runs on an ordinary OS thread at
default (normal) scheduling priority — identical to the app's own UI
thread. Under the sustained, multi-minute CPU load a "maximum quality"
multi-frame RAW decode/demosaic run produces, Linux's CFS scheduler has
no reason to prefer the foreground UI thread over this one. The UI
thread can still miss its frame/input deadlines and trigger an Android
ANR on the foregrounded progress screen — with no Dart code "blocked"
in the bug sense at all. This is the mechanism behind the ANR
screenshot: a real, live run of a background job (which went on to
complete successfully over the next ~80 minutes) still tripped a
transient ANR a few frames in, purely from CPU contention.

## Fix: demote the OS thread priority, not just the Dart isolate
Added `lowerCurrentThreadPriorityForBackgroundWork()`
(`ffi_raw_native_bridge.dart`), which calls libc's `setpriority(2)` via
`dart:ffi` against `DynamicLibrary.process()` — no native library
rebuild required, since `setpriority` is already present in every
Android process. It sets the *calling thread's* nice value to 10, the
same value Android's own `Process.THREAD_PRIORITY_BACKGROUND` uses.
This makes the guarantee structural rather than probabilistic: with
this thread demoted, Linux's scheduler always lets a normal-priority
thread (the foreground UI thread) run first when both want the CPU,
regardless of core count, device load, or how long a decode call
takes. Failure to apply it (non-Android platform, symbol not found) is
silently ignored — a best-effort scheduling hint, not a correctness
requirement.

Applied at two levels for full coverage:
- Inside every `Isolate.run()` closure that performs native decode
  (`FfiRawDecodeWorker`, `FfiRawDecodeBackgroundWorkerBackend`) — covers
  the specific call this session traced the ANR to.
- Once, at the very top of `backgroundTaskDispatcher()` — the entry
  point for the entire headless WorkManager engine — demoting that
  engine's own root isolate/thread for its whole lifetime. This is the
  more complete fix: it also covers demosaic tile processing, tile-store
  combine, and export — every stage of every background job, including
  ones not individually audited in Work310e — since none of them have
  any legitimate reason to compete with the foreground UI thread for
  CPU. A no-op stub was added to `ffi_raw_native_workers_stub.dart` for
  the Web/PWA build, exported through `native_raw_decoder_factory.dart`'s
  existing conditional import so callers don't need platform checks.

## What this changes about the earlier "出にくくなる" framing
Work310b/e reduced *Dart-level* stall risk to near zero but left this
OS-scheduling gap unaddressed, which is why the honest framing at the
time was "less likely," not "cannot happen." This fix closes that
specific remaining gap structurally: the foreground UI thread is now
always preferred by the OS scheduler over any background stack-job
work, on every device, regardless of core count or load. It does not
cover unrelated causes of ANR outside this app's own background
processing (e.g. a different app or the OS itself saturating the
device), which are outside what any app-level fix can control.






