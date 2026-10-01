package com.mobilestack.app

import android.app.ActivityManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Debug
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.os.ResultReceiver
import android.util.Log
import android.provider.MediaStore
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

class MainActivity : FlutterActivity() {
    private val fileExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingSupervisorStart: SupervisorStartRequest? = null
    private var supervisorRetryScheduled = false
    // Keyed by jobId (stable across a job's start/restart calls — see
    // BackgroundStackController). StackJobRegistry prevents a second durable
    // job generation in the normal Dart path; this per-job map remains a
    // defense against Android intent redelivery, cross-version callers, and
    // concurrent retry/manual-resume requests. Coalescing must be keyed by job
    // identity, not "whatever launch happens to be pending".
    private val pendingProcessorLaunches = mutableMapOf<String, ProcessorLaunchState>()

    private data class SupervisorStartRequest(
        val taskName: String,
        val payloadPath: String,
        val statusPath: String,
        val uniqueName: String,
        val jobId: String,
    )

    // A caller awaiting the outcome of a processor launch attempt. Distinct
    // callers (e.g. the automatic foreground-timeout resume and the user's
    // manual "保存済み地点から再開" button) can each be waiting on their own
    // MethodChannel.Result at the same time; every one of them must be told
    // the eventual outcome rather than one silently clobbering another's
    // pending Result.
    private data class ProcessorLaunchWaiter(
        val result: MethodChannel.Result,
        val errorCode: String,
        val defaultErrorMessage: String,
        val isRestart: Boolean,
    )

    // The processor is the authoritative image-processing job, so unlike the
    // auxiliary supervisor its FGS-start denial cannot simply be logged and
    // dropped. It is retried the same way (deferred + foreground-focus
    // triggered) for a bounded number of attempts before genuinely failing.
    // If a second caller requests a launch for the *same job* (same jobId)
    // while a retry is already pending, it is added as another waiter on
    // that same attempt instead of starting a competing one. A request for a
    // *different* job never joins this state (see pendingProcessorLaunches).
    private class ProcessorLaunchState(val supervisorRequest: SupervisorStartRequest) {
        val waiters = mutableListOf<ProcessorLaunchWaiter>()
        var attempt = 0
        var retryScheduled = false
        var awaitingServiceAck = false
        var ackTimeout: Runnable? = null
        // Work352: number of :processor foreground resets requested for this
        // launch (bounded by MAX_PROCESSOR_BUDGET_RESETS).
        var budgetResets = 0
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        StackStatusStore.attach(flutterEngine.dartExecutor.binaryMessenger)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            RESULT_FILES_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "saveResult" -> saveResult(call, result)
                else -> result.notImplemented()
            }
        }
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            DEVICE_RESOURCES_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "readResourceSnapshot" -> result.success(readResourceSnapshot())
                else -> result.notImplemented()
            }
        }
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            PROCESSOR_CONTROL_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "startProcessor" -> startProcessor(call, result, restart = false)
                "restartProcessor" -> startProcessor(call, result, restart = true)
                "abandonProcessor" -> abandonProcessor(call, result)
                else -> result.notImplemented()
            }
        }
    }

    private fun abandonProcessor(call: MethodCall, result: MethodChannel.Result) {
        val statusPath = call.argument<String>("statusPath")
        val jobId = call.argument<String>("jobId")
        if (statusPath.isNullOrBlank() || jobId.isNullOrBlank()) {
            result.error("invalid_abandon_arguments", "破棄対象ジョブがありません。", null)
            return
        }
        try {
            File("$statusPath.abandon").apply {
                parentFile?.mkdirs()
                writeText(System.currentTimeMillis().toString())
            }
            pendingProcessorLaunches.remove(jobId)?.let { state ->
                state.ackTimeout?.let(mainHandler::removeCallbacks)
                state.waiters.forEach { waiter -> waiter.result.success(null) }
                state.waiters.clear()
            }
            try { stopService(Intent(this, SupervisorService::class.java)) } catch (_: Throwable) { }
            try { stopService(Intent(this, ProcessorService::class.java)) } catch (_: Throwable) { }
            val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val processorName = "$packageName:processor"
            manager.runningAppProcesses
                ?.firstOrNull { it.processName == processorName }
                ?.pid
                ?.takeIf { it > 0 }
                ?.let { android.os.Process.killProcess(it) }
            result.success(null)
        } catch (error: Throwable) {
            result.error("processor_abandon_failed", error.message ?: "ジョブを破棄できませんでした。", null)
        }
    }

    /// Real-device counterpart to Dart's `readDefaultResourceSnapshot`
    /// placeholder. Both sides previously fell back to 2 GiB free / 0.0
    /// thermal / 100% battery on any read failure — the healthiest possible
    /// corner of every downstream threshold (see concurrency_policy.dart),
    /// despite being commented "safe"/"conservative". A failed reading is
    /// the one time this code has *no idea* what state the device is
    /// actually in, so it should not also be the one time every concurrency
    /// guard stands down; these fallbacks now land just inside each
    /// threshold's first restricted tier instead, without collapsing all
    /// the way to the most extreme tier on a single transient failure.
    private fun readResourceSnapshot(): Map<String, Any> {
        var availableMemoryBytes = 850L * 1024 * 1024
        var totalMemoryBytes = 0L
        try {
            val activityManager =
                getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val memoryInfo = ActivityManager.MemoryInfo()
            activityManager.getMemoryInfo(memoryInfo)
            availableMemoryBytes = memoryInfo.availMem
            totalMemoryBytes = memoryInfo.totalMem
        } catch (_: Throwable) {
            // Keep conservative fallbacks.
        }

        val processRssBytes = try {
            Debug.getPss().toLong() * 1024L
        } catch (_: Throwable) {
            -1L
        }

        var batteryLevel = 0.12
        try {
            val batteryManager =
                getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val capacity = batteryManager.getIntProperty(
                BatteryManager.BATTERY_PROPERTY_CAPACITY,
            )
            if (capacity in 0..100) batteryLevel = capacity / 100.0
        } catch (_: Throwable) {
            // Keep the conservative default.
        }

        val batteryTemperatureC = try {
            val batteryIntent = registerReceiver(
                null,
                IntentFilter(Intent.ACTION_BATTERY_CHANGED),
            )
            val tenths = batteryIntent?.getIntExtra(
                BatteryManager.EXTRA_TEMPERATURE,
                Int.MIN_VALUE,
            ) ?: Int.MIN_VALUE
            if (tenths == Int.MIN_VALUE) Double.NaN else tenths / 10.0
        } catch (_: Throwable) {
            Double.NaN
        }

        val thermalPressure = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
                when (powerManager.currentThermalStatus) {
                    PowerManager.THERMAL_STATUS_NONE -> 0.0
                    PowerManager.THERMAL_STATUS_LIGHT -> 0.25
                    PowerManager.THERMAL_STATUS_MODERATE -> 0.50
                    PowerManager.THERMAL_STATUS_SEVERE -> 0.70
                    PowerManager.THERMAL_STATUS_CRITICAL -> 0.85
                    PowerManager.THERMAL_STATUS_EMERGENCY -> 0.95
                    PowerManager.THERMAL_STATUS_SHUTDOWN -> 1.0
                    // Conservative fallback for an unrecognized status
                    // constant (e.g. a future OS value), not "no throttling".
                    else -> 0.5
                }
            } catch (_: Throwable) {
                // Conservative fallback: API present but the call itself
                // failed, so the real state is unknown.
                0.5
            }
        } else {
            // Pre-Android-Q has no thermal status API at all: genuinely
            // unknown, not "confirmed cool". Same conservative fallback.
            0.5
        }

        val availableStorageBytes = try {
            cacheDir.usableSpace
        } catch (_: Throwable) {
            -1L
        }

        return mapOf(
            "availableMemoryBytes" to availableMemoryBytes,
            "totalMemoryBytes" to totalMemoryBytes,
            "processRssBytes" to processRssBytes,
            "availableStorageBytes" to availableStorageBytes,
            "thermalPressure" to thermalPressure,
            "batteryLevel" to batteryLevel,
            "batteryTemperatureC" to batteryTemperatureC,
        )
    }

    private fun startProcessor(
        call: MethodCall,
        result: MethodChannel.Result,
        restart: Boolean,
    ) {
        val taskName = call.argument<String>("taskName")
        val payloadPath = call.argument<String>("payloadPath")
        val statusPath = call.argument<String>("statusPath")
        val uniqueName = call.argument<String>("uniqueName")
        val jobId = call.argument<String>("jobId")
        if (taskName.isNullOrBlank() || payloadPath.isNullOrBlank() ||
            statusPath.isNullOrBlank() || uniqueName.isNullOrBlank() ||
            jobId.isNullOrBlank()) {
            result.error("invalid_processor_arguments", "処理システムの起動情報が不足しています。", null)
            return
        }

        val supervisorRequest = SupervisorStartRequest(
            taskName = taskName,
            payloadPath = payloadPath,
            statusPath = statusPath,
            uniqueName = uniqueName,
            jobId = jobId,
        )

        if (!restart) {
            // The heavy processor is the user's actual job. Launch it first.
            // Work329 started the auxiliary SupervisorService first, so a
            // transient Android FGS-start denial for the supervisor aborted
            // the entire job before ProcessorService was ever launched.
            requestProcessorLaunch(
                supervisorRequest,
                ProcessorLaunchWaiter(
                    result = result,
                    errorCode = "processor_start_failed",
                    defaultErrorMessage = "画像処理システムを起動できませんでした。",
                    isRestart = false,
                ),
            )
            return
        }

        // Explicit/manual or foreground-auto restart. Kill only :processor;
        // :supervisor and UI remain alive. The processor remains authoritative;
        // supervisor launch is best-effort and cannot turn a successful restart
        // into a user-visible processing failure.
        try {
            val waiter = ProcessorLaunchWaiter(
                result = result,
                errorCode = "processor_restart_failed",
                defaultErrorMessage = "画像処理システムを再起動できませんでした。",
                isRestart = true,
            )
            val existing = pendingProcessorLaunches[jobId]
            if (existing != null) {
                existing.waiters.add(waiter)
                return
            }
            // Register before waiting for process death. This guarantees that
            // Activity destruction and a duplicate restart request can always
            // find and complete the pending MethodChannel result.
            val state = ProcessorLaunchState(supervisorRequest)
            state.waiters.add(waiter)
            pendingProcessorLaunches[jobId] = state
            val activityManager =
                getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val processorName = "$packageName:processor"
            val targetPid = activityManager.runningAppProcesses
                ?.firstOrNull { it.processName == processorName }
                ?.pid
                ?.takeIf { it > 0 }
            // Stop the Service association before killing the process:
            // ProcessorService returns START_REDELIVER_INTENT, and killing
            // the process while that contract is active can make Android
            // itself resurrect the Service (and intent) mid-restart, racing
            // this explicit relaunch. stopService() first (mirroring
            // SupervisorService's own restart order) cancels that contract.
            stopService(Intent(this, ProcessorService::class.java))
            targetPid?.let { android.os.Process.killProcess(it) }
            awaitProcessorDeathThenLaunch(
                activityManager = activityManager,
                processorName = processorName,
                targetPid = targetPid,
                state = state,
                deadlineElapsedRealtimeMs =
                    android.os.SystemClock.elapsedRealtime() + PROCESSOR_DEATH_MAX_WAIT_MS,
            )
        } catch (error: Throwable) {
            pendingProcessorLaunches[jobId]?.let { failProcessorLaunch(it, error) }
                ?: result.error(
                    "processor_restart_failed",
                    error.message ?: "画像処理システムを再起動できませんでした。",
                    null,
                )
        }
    }

    // Replaces a blind, fixed-duration wait after killProcess() with polling
    // for the :processor entry to actually disappear from
    // ActivityManager.runningAppProcesses before relaunching. A crash dialog
    // observed after a restart attempt (100% reproducible, with no trace in
    // either the Dart-side diagnostic log or writeBootstrapFailure's status
    // write) is consistent with the freshly-launched process racing the
    // still-tearing-down old one, though — per
    // INCIDENT_REPORT_processor_restart_crash.md — that evidence alone does
    // not confirm the failure happens below Dart, or rule out a native
    // crash; logcat/tombstone would be needed to say more. A fixed 750ms
    // guess could be too short on a device under load (e.g. right after a
    // 6-hour foreground-service run); confirming actual death first is
    // strictly safer regardless of which of those it turns out to be.
    // PROCESSOR_DEATH_SETTLE_MS keeps a small buffer after confirmed death
    // for any OS-level teardown that lags behind the process disappearing
    // from this list; the overall PROCESSOR_DEATH_MAX_WAIT_MS timeout still
    // bounds the wait so a permanently-stuck listing (or a device where
    // this API is unreliable) cannot stall the restart forever.
    //
    // Checks the captured [targetPid], not just [processorName]: Android can
    // reuse the same process name for a freshly (re)spawned :processor
    // almost immediately (including, if stopService() were ever skipped
    // before the kill, one the OS itself resurrects via
    // ProcessorService's START_REDELIVER_INTENT contract). A name-only
    // check cannot tell that new process apart from the one being waited on
    // and could treat the wait as unsatisfied indefinitely, or as satisfied
    // by the wrong process. [targetPid] is null only if no processor was
    // running to begin with, in which case name presence is the only signal
    // available.
    private fun awaitProcessorDeathThenLaunch(
        activityManager: ActivityManager,
        processorName: String,
        targetPid: Int?,
        state: ProcessorLaunchState,
        deadlineElapsedRealtimeMs: Long,
    ) {
        if (pendingProcessorLaunches[state.supervisorRequest.jobId] !== state) return
        val processes = try {
            activityManager.runningAppProcesses
        } catch (error: Throwable) {
            Log.w(TAG, "Could not query processor liveness; continuing bounded wait", error)
            null
        }
        val stillAlive = processes?.any {
            if (targetPid != null) it.pid == targetPid else it.processName == processorName
        }
        val timedOut = android.os.SystemClock.elapsedRealtime() >= deadlineElapsedRealtimeMs
        // A null process list means "unknown", not "dead". Keep polling until
        // the bounded deadline instead of racing an old process teardown.
        if (stillAlive != false && !timedOut) {
            mainHandler.postDelayed({
                try {
                    awaitProcessorDeathThenLaunch(
                        activityManager,
                        processorName,
                        targetPid,
                        state,
                        deadlineElapsedRealtimeMs,
                    )
                } catch (error: Throwable) {
                    failProcessorLaunch(state, error)
                }
            }, PROCESSOR_DEATH_POLL_INTERVAL_MS)
            return
        }
        if (timedOut && stillAlive != false) {
            failProcessorLaunch(state, IllegalStateException(
                "旧処理プロセスの終了を確認できませんでした。安全のため再起動を停止しました。",
            ))
            return
        }
        mainHandler.postDelayed({
            try {
                if (pendingProcessorLaunches[state.supervisorRequest.jobId] === state) {
                    attemptProcessorLaunch(state)
                }
            } catch (error: Throwable) {
                failProcessorLaunch(state, error)
            }
        }, PROCESSOR_DEATH_SETTLE_MS)
    }


    // for [supervisorRequest]'s job. If a launch attempt for *this same job*
    // (matched by jobId) is already pending (deferred after an Android
    // FGS-start denial — see [attemptProcessorLaunch]), [waiter] simply joins
    // that attempt's waiter list instead of starting a second, competing
    // attempt that could overwrite it and silently drop the first caller's
    // Result forever (e.g. the automatic foreground-timeout resume and the
    // user's manual "保存済み地点から再開" button racing each other for the
    // same job). A request for a *different* job always gets its own,
    // independent attempt — an interruptedRecoverable job being retried must
    // never absorb a brand-new, unrelated job's launch outcome.
    private fun requestProcessorLaunch(
        supervisorRequest: SupervisorStartRequest,
        waiter: ProcessorLaunchWaiter,
    ) {
        val existing = pendingProcessorLaunches[supervisorRequest.jobId]
        if (existing != null) {
            existing.waiters.add(waiter)
            return
        }
        val state = ProcessorLaunchState(supervisorRequest)
        state.waiters.add(waiter)
        pendingProcessorLaunches[supervisorRequest.jobId] = state
        attemptProcessorLaunch(state)
    }

    // Launches ProcessorService and, on success, tells every waiter
    // registered on [state] (see [requestProcessorLaunch]) and kicks off the
    // best-effort supervisor. A transient Android FGS-start denial for the
    // *processor itself* (the same class of race the automatic
    // foreground-timeout-resume path can hit — see Work330) is retried a
    // bounded number of times, deferred and foreground-focus triggered
    // exactly like the supervisor's own retry, so a fleeting denial at the
    // exact resume instant does not surface a permanent, unretryable
    // "処理に失敗しました" screen for a job that is otherwise perfectly
    // recoverable.
    private fun attemptProcessorLaunch(state: ProcessorLaunchState) {
        val jobId = state.supervisorRequest.jobId
        if (pendingProcessorLaunches[jobId] !== state || state.awaitingServiceAck) return
        try {
            val acknowledgement = object : ResultReceiver(mainHandler) {
                override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
                    if (pendingProcessorLaunches[jobId] !== state) return
                    if (resultCode == ProcessorService.RESULT_LAUNCH_ACCEPTED) {
                        completeProcessorLaunch(state)
                    } else {
                        val message =
                            resultData?.getString(ProcessorService.RESULT_ERROR_MESSAGE)
                                ?: "画像処理システムが起動を受理できませんでした。"
                        val error = IllegalStateException(message)
                        val serviceErrorCode =
                            resultData?.getString(ProcessorService.RESULT_ERROR_CODE)

                        // startForegroundService() itself can be accepted while
                        // ProcessorService.startForeground() then rejects the
                        // promotion because the mediaProcessing six-hour budget
                        // is still considered exhausted. That failure arrives
                        // here asynchronously via ResultReceiver, so the old
                        // catch-only retry path never saw it and immediately
                        // surfaced processor_restart_failed. Keep the launch
                        // pending instead: once this Activity has real window
                        // focus Android has a foreground reset point and the
                        // same bounded retry path can continue from checkpoint
                        // without requiring a device reboot.
                        if ((serviceErrorCode == ProcessorService.ERROR_FGS_BUDGET_EXHAUSTED ||
                                isForegroundServiceTimeLimitExhausted(error)) &&
                            state.attempt < MAX_PROCESSOR_FGS_RETRIES) {
                            state.awaitingServiceAck = false
                            state.ackTimeout?.let(mainHandler::removeCallbacks)
                            state.ackTimeout = null
                            state.attempt += 1
                            Log.w(
                                TAG,
                                "Processor FGS budget exhausted after service start; " +
                                    "deferring foreground retry " +
                                    "(${state.attempt}/$MAX_PROCESSOR_FGS_RETRIES) for job $jobId",
                                error,
                            )
                            scheduleProcessorRetry(state)
                            requestProcessorForegroundReset(state)
                        } else {
                            failProcessorLaunch(state, error)
                        }
                    }
                }
            }
            val timeout = Runnable {
                if (pendingProcessorLaunches[jobId] === state && state.awaitingServiceAck) {
                    preserveUnconfirmedLaunch(
                        state,
                        "画像処理システムの起動確認がタイムアウトしました。",
                    )
                }
            }
            state.awaitingServiceAck = true
            state.ackTimeout = timeout
            mainHandler.postDelayed(timeout, PROCESSOR_LAUNCH_ACK_TIMEOUT_MS)
            val processorIntent = ProcessorService.createIntent(
                context = this,
                taskName = state.supervisorRequest.taskName,
                payloadPath = state.supervisorRequest.payloadPath,
                statusPath = state.supervisorRequest.statusPath,
                uniqueName = state.supervisorRequest.uniqueName,
                jobId = jobId,
                launchReceiver = acknowledgement,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(processorIntent)
            } else {
                startService(processorIntent)
            }
            // Start supervision as soon as Android accepts the service start;
            // caller success still waits for ProcessorService's runtime ack.
            startSupervisorBestEffort(state.supervisorRequest)
        } catch (error: Throwable) {
            state.awaitingServiceAck = false
            state.ackTimeout?.let(mainHandler::removeCallbacks)
            state.ackTimeout = null
            if ((isForegroundStartNotAllowed(error) ||
                    isForegroundServiceTimeLimitExhausted(error)) &&
                state.attempt < MAX_PROCESSOR_FGS_RETRIES) {
                state.attempt += 1
                Log.w(
                    TAG,
                    "Processor FGS start denied; deferring retry " +
                        "(${state.attempt}/$MAX_PROCESSOR_FGS_RETRIES) for " +
                        "${state.waiters.size} waiter(s) of job $jobId",
                    error,
                )
                scheduleProcessorRetry(state)
                if (isForegroundServiceTimeLimitExhausted(error)) {
                    requestProcessorForegroundReset(state)
                }
            } else {
                failProcessorLaunch(state, error)
            }
        }
    }

    private fun completeProcessorLaunch(state: ProcessorLaunchState) {
        val jobId = state.supervisorRequest.jobId
        if (pendingProcessorLaunches[jobId] !== state) return
        pendingProcessorLaunches.remove(jobId)
        state.awaitingServiceAck = false
        state.ackTimeout?.let(mainHandler::removeCallbacks)
        state.ackTimeout = null
        state.waiters.toList().forEach { it.result.success(null) }
        state.waiters.clear()
    }

    private fun failProcessorLaunch(state: ProcessorLaunchState, error: Throwable) {
        val jobId = state.supervisorRequest.jobId
        if (pendingProcessorLaunches[jobId] !== state) return
        pendingProcessorLaunches.remove(jobId)
        state.awaitingServiceAck = false
        state.ackTimeout?.let(mainHandler::removeCallbacks)
        state.ackTimeout = null
        if (state.waiters.any { it.isRestart }) {
            markJobRecoverableAfterProcessorLaunchFailure(
                state.supervisorRequest.statusPath,
                error.message ?: "processor restart failed",
            )
        }
        state.waiters.toList().forEach { waiter ->
            waiter.result.error(
                waiter.errorCode,
                error.message ?: waiter.defaultErrorMessage,
                null,
            )
        }
        state.waiters.clear()
    }

    private fun preserveUnconfirmedLaunch(state: ProcessorLaunchState, reason: String) {
        // startForegroundService() was accepted, so deleting the payload here
        // could race a late FlutterEngine startup. Preserve the durable job and
        // let the UI/supervisor retry it from checkpoints instead.
        markJobRecoverableAfterProcessorLaunchFailure(
            state.supervisorRequest.statusPath,
            reason,
            RECOVERY_CAUSE_PROCESSOR_LAUNCH_UNCONFIRMED,
        )
        completeProcessorLaunch(state)
    }

    // A restart failure, or a first start accepted by Android whose launch
    // acknowledgement never arrives, must not leave the
    // persisted job status stuck at a stale "queued"/"running" snapshot no
    // one is ever going to correct. A job stuck that way is invisible to
    // both ForegroundTimeoutRecovery (which only acts on
    // interruptedRecoverable) and StackJobRegistry.activeJob() (which treats
    // "running" as still active, blocking any new job forever). Downgrading
    // it to interruptedRecoverable — the same self-healing state a
    // foreground-service-timeout produces — puts it back on the one
    // already-audited recovery path: a later foreground/window-focus event,
    // or the user's own "保存済み地点から再開" button, will pick it up.
    // A first start that is rejected synchronously is not routed here:
    // BackgroundStackController tears that job down. An unconfirmed first
    // start is routed here because the service may still start after the
    // Activity timeout, so deleting its payload would create a race.
    private fun markJobRecoverableAfterProcessorLaunchFailure(
        statusPath: String,
        reason: String,
        recoveryCause: String = RECOVERY_CAUSE_PROCESSOR_RESTART_DENIED,
    ) {
        try {
            val file = File(statusPath)
            val json = if (file.isFile) JSONObject(file.readText()) else return
            val currentState = json.optString("state", "")
            // Only a job that still claims to be in-flight needs downgrading.
            // One that already reached a terminal state on its own (completed,
            // cancelled, failed) or is already interruptedRecoverable must be
            // left untouched.
            if (currentState != "queued" && currentState != "running") return
            json.put("state", "interruptedRecoverable")
            json.put("stage", "処理システム起動確認失敗・操作待ち")
            json.put("updatedEpochMs", System.currentTimeMillis())
            json.put("progressEpochMs", System.currentTimeMillis())
            json.put("recoveryCause", recoveryCause)
            json.put(
                "error",
                "画像処理システムの起動を確認できませんでした。保存済みチェックポイントは保持されています。",
            )
            StackStatusStore.writeSnapshot(statusPath, json, resume = false)
        } catch (error: Throwable) {
            Log.e(TAG, "Could not mark job recoverable after processor restart failure: $reason", error)
        }
    }

    // Work352: Android resets an exhausted mediaProcessing budget only when
    // the process hosting the service has been TOP since the timeout. That
    // is :processor, not this (main) process, so show the translucent
    // ProcessorForegroundResetActivity (declared in :processor) once. When it
    // finishes, this Activity regains focus and onWindowFocusChanged() runs
    // the normal bounded retry. Only while this Activity has focus (user is
    // actually in the app), and at most MAX_PROCESSOR_BUDGET_RESETS times.
    private fun requestProcessorForegroundReset(state: ProcessorLaunchState) {
        if (state.budgetResets >= MAX_PROCESSOR_BUDGET_RESETS) return
        if (!hasWindowFocus()) return
        state.budgetResets += 1
        try {
            startActivity(Intent(this, ProcessorForegroundResetActivity::class.java))
            Log.i(
                TAG,
                "Requested :processor foreground reset " +
                    "(${state.budgetResets}/$MAX_PROCESSOR_BUDGET_RESETS) for job " +
                    state.supervisorRequest.jobId,
            )
        } catch (error: Throwable) {
            Log.w(TAG, "Could not start :processor foreground reset", error)
        }
    }

    private fun scheduleProcessorRetry(state: ProcessorLaunchState) {
        if (state.retryScheduled) return
        state.retryScheduled = true
        mainHandler.postDelayed({
            state.retryScheduled = false
            retryProcessorLaunchIfForeground(state)
        }, 500L)
    }

    private fun retryProcessorLaunchIfForeground(state: ProcessorLaunchState) {
        // Defensive: only proceed if this state is still the one registered
        // for its job. attemptProcessorLaunch always removes a state from
        // the map on any terminal outcome before notifying waiters, so this
        // should always hold, but guards against acting on a stale retry.
        if (pendingProcessorLaunches[state.supervisorRequest.jobId] !== state) return
        if (state.awaitingServiceAck) return
        if (!hasWindowFocus()) {
            // onWindowFocusChanged() performs the next retry. Reposting every
            // 500 ms while another app is foreground would be an unbounded
            // wake-up loop with no chance of a legal FGS start.
            return
        }
        attemptProcessorLaunch(state)
    }

    // Called when the window regains focus: every job currently deferred
    // after an FGS denial (there can be more than one — see
    // pendingProcessorLaunches) gets an immediate retry rather than waiting
    // for its next scheduled 500ms tick.
    private fun retryAllPendingProcessorLaunchesIfForeground() {
        if (!hasWindowFocus()) return
        pendingProcessorLaunches.values.toList()
            .filterNot { it.awaitingServiceAck }
            .forEach { attemptProcessorLaunch(it) }
    }

    private fun startSupervisorBestEffort(request: SupervisorStartRequest) {
        try {
            val supervisorIntent = SupervisorService.createIntent(
                context = this,
                taskName = request.taskName,
                payloadPath = request.payloadPath,
                statusPath = request.statusPath,
                uniqueName = request.uniqueName,
                jobId = request.jobId,
                resetRetryBudget = true,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(supervisorIntent)
            } else {
                startService(supervisorIntent)
            }
            pendingSupervisorStart = null
            supervisorRetryScheduled = false
        } catch (error: Throwable) {
            // Supervisor is resilience infrastructure, not the processing
            // engine: no failure here should turn into a user-visible
            // processing failure, so the already-running processor is
            // always preserved regardless of why this failed. Previously
            // only the FGS-denial branch retried; any other exception
            // (resource limits, security exceptions, ...) just logged and
            // gave up, leaving no independent watchdog for the rest of this
            // job if the processor later crashed, hung, or was OS-killed
            // with nothing else around to notice. Retrying regardless of
            // cause closes that gap; it costs nothing extra; a genuinely
            // permanent condition just keeps failing silently in the log on
            // each foreground-focus retry rather than being treated as
            // fatal to supervision.
            if (isForegroundStartNotAllowed(error)) {
                // This is commonly a very short Activity transition around a
                // system picker / lifecycle hand-off.
                Log.w(TAG, "Supervisor FGS start denied; processor continues and supervisor is deferred", error)
            } else {
                Log.e(TAG, "Supervisor start failed; processor continues and supervisor is deferred", error)
            }
            pendingSupervisorStart = request
            scheduleSupervisorRetry()
        }
    }

    private fun scheduleSupervisorRetry() {
        if (supervisorRetryScheduled) return
        supervisorRetryScheduled = true
        mainHandler.postDelayed({
            supervisorRetryScheduled = false
            retryPendingSupervisorIfForeground()
        }, 500L)
    }

    private fun retryPendingSupervisorIfForeground() {
        val request = pendingSupervisorStart ?: return
        if (!hasWindowFocus()) {
            // Resume from onWindowFocusChanged(); do not poll forever while
            // this Activity is not foreground.
            return
        }
        pendingSupervisorStart = null
        startSupervisorBestEffort(request)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            retryAllPendingProcessorLaunchesIfForeground()
            retryPendingSupervisorIfForeground()
        }
    }

    private fun isForegroundStartNotAllowed(error: Throwable): Boolean {
        if (error.javaClass.simpleName == "ForegroundServiceStartNotAllowedException") return true
        val message = error.message ?: return false
        return message.contains("startForegroundService() not allowed", ignoreCase = true) ||
            message.contains("mAllowStartForeground false", ignoreCase = true)
    }

    private fun isForegroundServiceTimeLimitExhausted(error: Throwable): Boolean {
        val message = error.message ?: return false
        return message.contains("Time limit already exhausted", ignoreCase = true)
    }

    override fun onDestroy() {
        pendingSupervisorStart = null
        supervisorRetryScheduled = false
        pendingProcessorLaunches.values.forEach { state ->
            state.ackTimeout?.let(mainHandler::removeCallbacks)
            if (state.awaitingServiceAck) {
                markJobRecoverableAfterProcessorLaunchFailure(
                    state.supervisorRequest.statusPath,
                    "activity destroyed while processor acknowledgement was pending",
                    RECOVERY_CAUSE_PROCESSOR_LAUNCH_UNCONFIRMED,
                )
                state.waiters.forEach { it.result.success(null) }
            } else if (state.waiters.any { it.isRestart }) {
                markJobRecoverableAfterProcessorLaunchFailure(
                    state.supervisorRequest.statusPath,
                    "activity destroyed while a restart was pending",
                )
                state.waiters.forEach { waiter ->
                    waiter.result.error(
                        waiter.errorCode,
                        "アプリが終了したため画像処理システムの起動を確認できませんでした。",
                        null,
                    )
                }
            } else {
                state.waiters.forEach { waiter ->
                    waiter.result.error(
                        waiter.errorCode,
                        "アプリが終了したため画像処理システムを起動できませんでした。",
                        null,
                    )
                }
            }
        }
        pendingProcessorLaunches.clear()
        mainHandler.removeCallbacksAndMessages(null)
        fileExecutor.shutdown()
        super.onDestroy()
    }

    private fun saveResult(call: MethodCall, result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            result.error(
                "unsupported_android_version",
                "端末への直接保存はAndroid 10以上で利用できます。共有から保存してください。",
                null,
            )
            return
        }
        val sourcePath = call.argument<String>("sourcePath")
        val requestedName = call.argument<String>("displayName")
        if (sourcePath.isNullOrBlank() || requestedName.isNullOrBlank()) {
            result.error("invalid_arguments", "保存元またはファイル名がありません。", null)
            return
        }
        val source = File(sourcePath)
        val safeRequestedName = File(requestedName).name
        val allowedExtensions = setOf("bmp", "jpg", "jpeg", "tif", "tiff", "dng")
        val requestedExtension = File(safeRequestedName).extension.lowercase()
        val sourceExtension = source.extension.lowercase()
        val extension = when {
            requestedExtension in allowedExtensions -> requestedExtension
            sourceExtension in allowedExtensions -> sourceExtension
            else -> "bmp"
        }
        val requestedBase = File(safeRequestedName).nameWithoutExtension
        val displayName = "${requestedBase.ifBlank { "MobileStack_result" }}.$extension"
        val mimeType = when (extension) {
            "bmp" -> "image/bmp"
            "jpg", "jpeg" -> "image/jpeg"
            "dng" -> "image/x-adobe-dng"
            else -> "image/tiff"
        }
        fileExecutor.execute {
            val resolver = applicationContext.contentResolver
            var outputUri: android.net.Uri? = null
            try {
                if (!source.isFile) throw IllegalArgumentException("保存元ファイルがありません。")
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
                    put(MediaStore.Images.Media.MIME_TYPE, mimeType)
                    put(
                        MediaStore.Images.Media.RELATIVE_PATH,
                        "${Environment.DIRECTORY_PICTURES}/Mobile Stack",
                    )
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                outputUri = resolver.insert(
                    MediaStore.Images.Media.getContentUri(
                        MediaStore.VOLUME_EXTERNAL_PRIMARY,
                    ),
                    values,
                ) ?: throw IllegalStateException("保存先を作成できませんでした。")
                val output = resolver.openOutputStream(outputUri, "w")
                    ?: throw IllegalStateException("保存先を開けませんでした。")
                FileInputStream(source).use { input ->
                    output.use { destination ->
                        input.copyTo(destination, DEFAULT_BUFFER_SIZE)
                    }
                }
                val completed = ContentValues().apply {
                    put(MediaStore.Images.Media.IS_PENDING, 0)
                }
                resolver.update(outputUri, completed, null, null)
                runOnUiThread {
                    result.success("Pictures/Mobile Stack/$displayName")
                }
            } catch (error: Throwable) {
                outputUri?.let { resolver.delete(it, null, null) }
                runOnUiThread {
                    result.error("save_failed", error.message ?: "保存に失敗しました。", null)
                }
            }
        }
    }

    companion object {
        private const val TAG = "MobileStackMain"
        // 6 retries at 500ms = at most ~3s of deferral for a transient
        // FGS-start denial on the processor itself before genuinely failing.
        private const val MAX_PROCESSOR_FGS_RETRIES = 6
        // Work352: :processor foreground resets per launch attempt sequence.
        private const val MAX_PROCESSOR_BUDGET_RESETS = 2
        // Distinct from Work328's "foreground-service-timeout": this marks a
        // job whose *restart* attempt (not the original timeout) is what
        // failed to launch — e.g. the user's "処理システムだけ再起動して続行"
        // button for a hung processor. Dart's ForegroundTimeoutRecovery
        // treats both causes as equally recoverable.
        const val RECOVERY_CAUSE_PROCESSOR_RESTART_DENIED = "processor-restart-fgs-denied"
        const val RECOVERY_CAUSE_PROCESSOR_LAUNCH_UNCONFIRMED = "processor-launch-unconfirmed"
        // Poll-until-confirmed-dead replaces a blind fixed wait after
        // killProcess(). Poll every 100ms; once confirmed dead (or absent to
        // begin with), wait a further 250ms settle buffer before relaunching;
        // give up waiting (and launch anyway) after 5s total so a stuck or
        // unreliable process listing cannot stall a restart indefinitely.
        private const val PROCESSOR_DEATH_POLL_INTERVAL_MS = 100L
        private const val PROCESSOR_DEATH_SETTLE_MS = 250L
        private const val PROCESSOR_DEATH_MAX_WAIT_MS = 5000L
        private const val PROCESSOR_LAUNCH_ACK_TIMEOUT_MS = 30000L
        private const val RESULT_FILES_CHANNEL = "com.mobilestack.app/result_files"
        private const val DEVICE_RESOURCES_CHANNEL = "com.mobilestack.app/device_resources"
        private const val PROCESSOR_CONTROL_CHANNEL = "com.mobilestack.app/processor_control"
    }
}
