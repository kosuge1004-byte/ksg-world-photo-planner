package com.mobilestack.app

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Process
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Lightweight native supervisor hosted in its own `:supervisor` OS process.
 *
 * No FlutterEngine or image buffers live here. The supervisor owns only the
 * durable restart policy for `:processor`, collects Android process-exit
 * evidence, and prevents a deterministic failure from causing an infinite
 * restart loop.
 */
class SupervisorService : Service() {
    private data class Config(
        val taskName: String,
        val payloadPath: String,
        val statusPath: String,
        val uniqueName: String,
        val jobId: String,
    )

    private data class RetryLedger(
        val signature: String,
        val attempts: Int,
        val lastReason: String,
        val updatedEpochMs: Long,
    )

    private var monitorThread: HandlerThread? = null
    private var monitorHandler: Handler? = null
    private var activeConfig: Config? = null
    private var startedAtMs: Long = 0L
    private var lastProcessorSeenMs: Long = 0L
    private var restartInProgress = false
    private var lastCapturedExitTimestampMs = 0L
    private var foregroundStarted = false
    private var fgsBudgetRetryScheduledForStatusPath: String? = null
    private val fgsBudgetRetryAttempts = mutableMapOf<String, Int>()

    override fun onCreate() {
        super.onCreate()
        HandlerThread("MobileStackSupervisor", Process.THREAD_PRIORITY_BACKGROUND).also {
            it.start()
            monitorThread = it
            monitorHandler = Handler(it.looper)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = configFromIntent(intent) ?: readPersistedConfig()
        if (config == null) {
            Log.w(TAG, "No recoverable processor configuration; stopping supervisor")
            stopSupervisor(clearConfig = false)
            return START_NOT_STICKY
        }
        activeConfig = config
        startedAtMs = System.currentTimeMillis()
        persistConfig(config)
        // The 96-attempt FGS-budget wait counter otherwise lives only in
        // this process's memory (fgsBudgetRetryAttempts), so if :supervisor
        // itself is OS-killed mid-wait — plausible over the many hours a
        // long FGS wait can span — restarting reset the count to 0 and the
        // 96-attempt cap stopped meaning anything. Seed it back from the
        // one place this count is already durably persisted on every
        // retry: status.json's own recoveryAttempt field (written by
        // updateRecoveryFields), rather than adding a second persistence
        // mechanism.
        if (!fgsBudgetRetryAttempts.containsKey(config.statusPath)) {
            val status = readStatus(config.statusPath)
            val cause = status?.optString("recoveryCause", "") ?: ""
            if (status?.optString("state", "") == "interruptedRecoverable" &&
                FGS_BUDGET_RECOVERY_CAUSES.contains(cause)) {
                val priorAttempt = status.optInt("recoveryAttempt", 0)
                if (priorAttempt > 0) {
                    fgsBudgetRetryAttempts[config.statusPath] = priorAttempt
                }
            }
        }
        if (!foregroundStarted) {
            try {
                ensureNotificationChannel()
                startForeground(NOTIFICATION_ID, buildNotification("画像処理システムを監視中"))
                foregroundStarted = true
            } catch (error: Throwable) {
                Log.e(TAG, "Could not promote supervisor to foreground", error)
                stopSupervisor(clearConfig = false)
                return START_NOT_STICKY
            }
        }
        if (intent?.getBooleanExtra(EXTRA_RESET_RETRY_BUDGET, false) == true) {
            clearRetryLedger(config.statusPath)
            clearRecoveryFields(config.statusPath)
        }

        monitorHandler?.removeCallbacksAndMessages(null)
        monitorHandler?.post { scheduleNextPoll() }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        monitorHandler?.removeCallbacksAndMessages(null)
        monitorThread?.quitSafely()
        monitorHandler = null
        monitorThread = null
        super.onDestroy()
    }

    private fun scheduleNextPoll() {
        monitorHandler?.postDelayed({
            try {
                poll()
            } catch (error: Throwable) {
                Log.e(TAG, "Supervisor poll failed", error)
            } finally {
                if (activeConfig != null) scheduleNextPoll()
            }
        }, POLL_INTERVAL_MS)
    }

    private fun poll() {
        val config = activeConfig ?: return
        if (File("${config.statusPath}.abandon").isFile) {
            try { stopService(Intent(this, ProcessorService::class.java)) } catch (_: Throwable) { }
            processorPid()?.takeIf { it > 0 }?.let { Process.killProcess(it) }
            stopSupervisor(clearConfig = true)
            return
        }
        captureLatestProcessorExit(config)

        val status = readStatus(config.statusPath)
        val state = status?.optString("state", "") ?: ""
        val markerExists = restartMarker(config.statusPath).isFile ||
            maintenanceRestartMarker(config.statusPath).isFile

        if (state == "completed" || state == "cancelled" || state == "failed" ||
            state == "interruptedRecoverable") {
            if (state == "interruptedRecoverable" &&
                status?.optString("recoveryCause", "") == "external-resource-pause") {
                // Storage/required input selection needs an external change.
                // Preserve the job configuration for a later manual resume;
                // burning crash retries cannot fix this deliberate pause.
                try { restartMarker(config.statusPath).delete() } catch (_: Throwable) { }
                try { maintenanceRestartMarker(config.statusPath).delete() } catch (_: Throwable) { }
                stopSupervisor(clearConfig = false)
                return
            }
            if (state == "interruptedRecoverable" &&
                !markerExists &&
                FGS_BUDGET_RECOVERY_CAUSES.contains(status?.optString("recoveryCause", "") ?: "")) {
                // Same three causes ForegroundTimeoutRecovery (Dart) treats as
                // "checkpoints are safe, Android just would not let this
                // session run/restart" — not a real processing failure. Left
                // alone, this branch used to fall straight into the generic
                // terminal-state stop below, which meant an unattended
                // multi-day job silently stalled here until the person
                // physically reopened the app. The supervisor process is
                // hosted under the `specialUse` foreground-service type,
                // which carries none of `:processor`'s `mediaProcessing`
                // execution-time budget, so it can keep waiting and retrying
                // on its own for as long as it takes for that budget to
                // roll off — unlike a plain stall/crash, immediate retry is
                // guaranteed to fail again, so this path deliberately does
                // not go through requestAutomaticRecovery's short, fast
                // retry cap; see scheduleForegroundServiceBudgetRetry.
                scheduleForegroundServiceBudgetRetry(
                    config,
                    cause = status?.optString("recoveryCause", "") ?: "",
                )
                return
            }
            if (state == "interruptedRecoverable" && !markerExists) {
                // The marker is meant to be the durable proof a recovery was
                // requested (see StackJobReporter.failRecoverable), but its
                // write is itself best-effort — a write failure there (disk
                // full, I/O error) is caught and only logged, leaving
                // exactly this state: a valid recoverable status with no
                // marker. Previously indistinguishable from a real terminal
                // state below, permanently stranding the job until the
                // person manually reopens the app. One bounded automatic
                // recovery attempt (the same short, capped retry every
                // other crash/stall goes through) costs little and gives
                // this case a real chance to self-heal instead of none.
                requestAutomaticRecovery(config, status, "recoverable status without a restart marker")
                return
            }
            if (!markerExists) {
                Log.i(TAG, "Job reached terminal state=$state; stopping supervisor")
                stopSupervisor(clearConfig = true)
                return
            }
        }

        val maintenanceReason = maintenanceRestartMarker(config.statusPath)
            .takeIf { it.isFile }
            ?.let { marker ->
                try { marker.readText() } catch (_: Throwable) { null }
            }
            ?.substringAfter('|', "")
            ?.take(512)
        if (maintenanceReason != null) {
            // Maintenance used to bypass the retry ledger entirely. On a
            // device that can never satisfy the admission estimate that made
            // the same checkpoint recycle forever. Bound it like every other
            // same-location recovery.
            //
            // Request recovery BEFORE deleting the marker (was: delete then
            // request). The marker is the only durable evidence a recovery
            // was ever requested; deleting it first opened a process-death
            // window where a Supervisor kill between the delete and the
            // request lost the request entirely, with nothing left on disk
            // to retry from. requestAutomaticRecovery's own
            // updateRecoveryFields write lands before this returns, so by
            // the time the marker is removed below there is already
            // independent durable evidence of the attempt; a Supervisor
            // death before that point instead leaves the marker in place to
            // be picked up again next poll — redundant, not lost.
            requestAutomaticRecovery(
                config,
                status,
                "maintenance heap recycle: $maintenanceReason",
            )
            try { maintenanceRestartMarker(config.statusPath).delete() } catch (_: Throwable) { }
            return
        }

        if (restartMarker(config.statusPath).isFile) {
            // Same ordering fix as the maintenance marker above.
            requestAutomaticRecovery(config, status, "independent watchdog request")
            try { restartMarker(config.statusPath).delete() } catch (_: Throwable) { }
            return
        }

        val pid = processorPid()
        if (pid != null) {
            lastProcessorSeenMs = System.currentTimeMillis()
            val progressEpochMs = if (status == null) {
                0L
            } else {
                status.optLong("progressEpochMs", status.optLong("updatedEpochMs", 0L))
            }
            val lastProgressMs = if (progressEpochMs > 0L) {
                progressEpochMs
            } else {
                status?.optLong("updatedEpochMs", 0L) ?: 0L
            }
            if (state == "running" || state == "queued") {
                val referenceMs = if (lastProgressMs > 0L) lastProgressMs else startedAtMs
                val ageMs = System.currentTimeMillis() - referenceMs
                if (ageMs >= HARD_STALE_FALLBACK_MS) {
                    requestAutomaticRecovery(config, status, "status stale ${ageMs / 1000}s")
                }
            } else if (status == null &&
                System.currentTimeMillis() - startedAtMs >= HARD_STALE_FALLBACK_MS) {
                requestAutomaticRecovery(config, null, "status missing or unreadable")
            }
            return
        }

        val now = System.currentTimeMillis()
        val reference = if (lastProcessorSeenMs > 0L) lastProcessorSeenMs else startedAtMs
        if (now - reference < PROCESSOR_MISSING_GRACE_MS) return

        if (state == "running" || state == "queued" || state.isBlank()) {
            requestAutomaticRecovery(config, status, "processor process absent")
        }
    }

    /**
     * Waits out an exhausted `mediaProcessing` foreground-service execution
     * budget and retries on its own, unattended — the piece that lets a job
     * needing more wall-clock time than Android allows in one sitting still
     * run to completion over more than 24 hours without the person having to
     * keep reopening the app.
     *
     * Deliberately outside [requestAutomaticRecovery]'s bounded, fast-retry
     * policy: that policy exists to stop a *genuine* crash/stall loop
     * quickly, whereas retrying here immediately is certain to hit the same
     * still-exhausted budget. Backs off between attempts instead, and does
     * not count attempts against [MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE] —
     * a multi-day job may legitimately need many such waits.
     */
    private fun scheduleForegroundServiceBudgetRetry(config: Config, cause: String) {
        if (fgsBudgetRetryScheduledForStatusPath == config.statusPath) return
        fgsBudgetRetryScheduledForStatusPath = config.statusPath
        val attempt = (fgsBudgetRetryAttempts[config.statusPath] ?: 0) + 1
        fgsBudgetRetryAttempts[config.statusPath] = attempt
        val delayMs = foregroundServiceBudgetRetryDelayMs(attempt, cause)
        Log.i(
            TAG,
            "Foreground-service budget recoverable; retrying in ${delayMs / 60_000}min " +
                "(attempt $attempt)",
        )
        updateSupervisorNotification(
            "Androidの実行時間制限で一時停止中。アプリを開くとすぐ再開できます（自動再試行 $attempt 回目）",
        )
        monitorHandler?.postDelayed({
            fgsBudgetRetryScheduledForStatusPath = null
            // Re-read rather than trust the captured `config`/status: the
            // person may have foregrounded the app and resumed manually (or
            // cancelled the job entirely) during the wait.
            if (activeConfig?.statusPath != config.statusPath) return@postDelayed
            val current = readStatus(config.statusPath)
            val currentState = current?.optString("state", "") ?: ""
            val currentCause = current?.optString("recoveryCause", "") ?: ""
            if (currentState != "interruptedRecoverable" ||
                !FGS_BUDGET_RECOVERY_CAUSES.contains(currentCause)) {
                // Already handled by something else (manual resume, a
                // different failure, cancellation, ...).
                return@postDelayed
            }
            if (attempt >= MAX_FGS_BUDGET_WAIT_RETRIES) {
                // A safety valve, not the expected outcome: this many
                // multi-hour waits (order of weeks) means something other
                // than a rolling execution-time budget is denying the
                // start, so stop pretending it will self-resolve.
                pauseRecovery(
                    config,
                    current,
                    signature = "fgs-budget-wait",
                    attempts = attempt,
                    reason = "foreground-service-budget-wait-exceeded",
                )
                return@postDelayed
            }
            updateRecoveryFields(
                config.statusPath,
                attempt = attempt,
                // Preserve whichever of the three FGS_BUDGET_RECOVERY_CAUSES
                // actually triggered this, rather than collapsing it to
                // "foreground-service-timeout" — that rewrite used to
                // destroy the distinction between a real 6-hour budget
                // timeout and a mere launch-ACK timeout on every retry pass.
                cause = currentCause,
                stage = "Androidの長時間処理制限の解除を待って自動再開中（$attempt 回目）",
                // Distinct denominator from the ordinary bounded-recovery
                // path below (MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE = 2):
                // without this, "recoveryAttempt/recoveryMaxAttempts" could
                // show something nonsensical like "3/2回" once an FGS
                // long-wait retry legitimately exceeds 2 attempts, which it
                // is expected to.
                maxAttempts = MAX_FGS_BUDGET_WAIT_RETRIES,
            )
            restartProcessor(config, "foreground-service-budget-wait-retry attempt=$attempt")
        }, delayMs)
    }

    /**
     * 30 minutes for the first few attempts, stepping up to a 2-hour ceiling.
     * Android's mediaProcessing budget is a rolling window (not reset by
     * simply waiting a fixed short interval), so early attempts are expected
     * to fail again; the ceiling keeps a very long job checking in a few
     * times an hour without hammering `startForeground()` uselessly.
     */
    /**
     * 30 minutes for the first few attempts, stepping up to a 2-hour ceiling.
     * Android's mediaProcessing budget is a rolling window (not reset by
     * simply waiting a fixed short interval), so early attempts are expected
     * to fail again; the ceiling keeps a very long job checking in a few
     * times an hour without hammering `startForeground()` uselessly.
     *
     * Exception: "processor-launch-unconfirmed" only means a ~30-second
     * launch acknowledgment did not arrive in time — it does not, by
     * itself, mean the mediaProcessing budget is exhausted the way an
     * actual onTimeout() or FGS-start-denial does. Grouping it with the
     * other two causes (see FGS_BUDGET_RECOVERY_CAUSES) still makes sense
     * for surviving unattended, but jumping straight to a 30-minute wait on
     * the very first occurrence would turn an ordinary transient ACK delay
     * into needless downtime. Give it one short retry first; if it keeps
     * happening, that is no longer "just a slow ACK" and the normal ramp
     * applies from the second attempt on.
     */
    private fun foregroundServiceBudgetRetryDelayMs(attempt: Int, cause: String): Long {
        if (cause == "processor-launch-unconfirmed" && attempt == 1) {
            return 15_000L
        }
        val steppedMinutes = (30L * attempt).coerceAtMost(120L)
        return steppedMinutes * 60_000L
    }

    /**
     * Applies the bounded recovery policy to one logical failure location.
     * The signature comes from the last journal ENTER operation where possible,
     * otherwise from stage/currentItem. If processing advances, the signature
     * changes and the retry budget automatically resets.
     */
    private fun requestAutomaticRecovery(config: Config, status: JSONObject?, reason: String) {
        val signature = recoverySignature(config, status)
        val previous = readRetryLedger(config.statusPath)
        val attemptsForSameLocation = if (previous?.signature == signature) previous.attempts else 0
        val nextAttempt = attemptsForSameLocation + 1

        if (nextAttempt > MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE) {
            pauseRecovery(config, status, signature, attemptsForSameLocation, reason)
            return
        }

        // Wait before repeated attempts at the same checkpoint. Persisting
        // the deadline prevents supervisor process death from skipping it.
        val delayFile = File("${config.statusPath}.recovery-backoff.json")
        if (nextAttempt > 1) {
            val pending = try {
                if (delayFile.isFile) JSONObject(delayFile.readText()) else null
            } catch (_: Throwable) { null }
            val ownsDelay = pending?.optString("signature", "") == signature &&
                pending.optInt("attempt", -1) == nextAttempt
            if (!ownsDelay) {
                val delayMs = minOf(120_000L, 15_000L * (1L shl minOf(nextAttempt - 1, 3)))
                try {
                    writeJsonAtomically(delayFile, JSONObject()
                        .put("signature", signature)
                        .put("attempt", nextAttempt)
                        .put("retryEpochMs", System.currentTimeMillis() + delayMs), ".recovery-backoff")
                } catch (error: Throwable) {
                    pauseRecovery(config, status, signature, attemptsForSameLocation,
                        "$reason; backoff could not be persisted: $error")
                }
                return
            }
            if (System.currentTimeMillis() < pending!!.optLong("retryEpochMs", Long.MAX_VALUE)) return
        }
        try { delayFile.delete() } catch (_: Throwable) { }

        val ledgerSaved = writeRetryLedger(
            config.statusPath,
            RetryLedger(signature, nextAttempt, reason, System.currentTimeMillis()),
        )
        if (!ledgerSaved) {
            pauseRecovery(
                config,
                status,
                signature,
                attemptsForSameLocation,
                "$reason; recovery ledger could not be persisted",
            )
            return
        }
        updateRecoveryFields(
            config.statusPath,
            attempt = nextAttempt,
            cause = reason,
            stage = "処理システム自動復旧 $nextAttempt/$MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE",
        )
        restartProcessor(config, "$reason; signature=$signature; attempt=$nextAttempt")
    }

    // State rank is a preliminary guard. StackStatusStore performs the
    // authoritative cross-process lock/revision check before every status write.
    private fun stateRank(state: String): Int = when (state) {
        "completed", "failed", "cancelled" -> 2
        "interruptedRecoverable" -> 1
        else -> 0
    }

    private fun wouldDowngradeState(statusPath: String, newState: String): Boolean {
        val currentState = try {
            readStatus(statusPath)?.optString("state", "")
        } catch (_: Throwable) {
            null
        } ?: return false
        return stateRank(currentState) > stateRank(newState)
    }

    private fun pauseRecovery(
        config: Config,
        status: JSONObject?,
        signature: String,
        attempts: Int,
        reason: String,
    ) {
        Log.e(TAG, "Automatic recovery paused after repeated failure at $signature")
        writeRetryLedger(
            config.statusPath,
            RetryLedger(signature, attempts, reason, System.currentTimeMillis()),
        )
        if (wouldDowngradeState(config.statusPath, "interruptedRecoverable")) {
            Log.w(TAG, "Skipping pause-recovery status write: a higher-authority state is on disk")
        } else try {
            val json = status ?: readStatus(config.statusPath) ?: JSONObject()
            json.put("state", "interruptedRecoverable")
            json.put("stage", "自動復旧停止・操作待ち")
            json.put("updatedEpochMs", System.currentTimeMillis())
            json.put("progressEpochMs", System.currentTimeMillis())
            json.put("recoveryAttempt", attempts)
            json.put("recoveryMaxAttempts", MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE)
            json.put("recoveryCause", reason)
            json.put(
                "error",
                "同じ処理地点で${attempts + 1}回目の停止を検出したため、自動再起動を停止しました。" +
                    "保存済みチェックポイントは保持されています。",
            )
            writeJsonAtomically(File(config.statusPath), json, ".supervisor-pause")
        } catch (error: Throwable) {
            Log.e(TAG, "Could not persist recovery pause", error)
        }
        try { restartMarker(config.statusPath).delete() } catch (_: Throwable) { }
        // Mark the started ProcessorService stopped as well as killing its
        // process. This prevents START_REDELIVER_INTENT from creating an
        // unbounded crash/restart loop after the retry budget is exhausted.
        try { stopService(Intent(this, ProcessorService::class.java)) } catch (_: Throwable) { }
        processorPid()?.takeIf { it > 0 }?.let { Process.killProcess(it) }
        updateSupervisorNotification("自動復旧を停止しました。アプリで確認してください")
        stopSupervisor(clearConfig = false)
    }

    private fun restartProcessor(config: Config, reason: String) {
        if (restartInProgress) return
        // Recheck the transaction result immediately before terminating work.
        // A stale recovery snapshot can be rejected while the job completes.
        val state = readStatus(config.statusPath)?.optString("state", "")
        if (state in setOf("completed", "failed", "cancelled")) return
        restartInProgress = true
        try {
            Log.w(TAG, "Terminating processor only for automatic recovery: $reason")
            // Remove the previous started-service record first. Recovery must
            // not depend on an optional START_REDELIVER_INTENT callback.
            try { stopService(Intent(this, ProcessorService::class.java)) } catch (_: Throwable) { }
            val pid = processorPid()
            if (pid != null && pid > 0) {
                Process.killProcess(pid)
            }
            startedAtMs = System.currentTimeMillis()
            lastProcessorSeenMs = 0L
            // Work334 gave MainActivity's manual restart path confirmed-death
            // polling instead of a fixed guess (the same race — a freshly
            // relaunched process could start while the old one is still
            // tearing down — was never actually specific to the manual
            // path). This mirrors that here rather than keeping the old
            // fixed PROCESS_RESTART_DELAY_MS wait for the one remaining
            // caller: automatic recovery.
            awaitProcessorDeathThenRestart(
                targetPid = pid?.takeIf { it > 0 },
                config = config,
                deadlineElapsedRealtimeMs =
                    android.os.SystemClock.elapsedRealtime() + PROCESSOR_DEATH_MAX_WAIT_MS,
            )
        } catch (error: Throwable) {
            restartInProgress = false
            Log.e(TAG, "Processor termination for recovery failed", error)
        }
    }

    private fun awaitProcessorDeathThenRestart(
        targetPid: Int?,
        config: Config,
        deadlineElapsedRealtimeMs: Long,
    ) {
        val stillAlive = if (targetPid == null) {
            try {
                val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                manager.runningAppProcesses?.any {
                    it.processName == "$packageName:processor"
                } ?: true
            } catch (_: Throwable) { true }
        } else {
            try {
                val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                manager.runningAppProcesses?.any { it.pid == targetPid } ?: true
            } catch (error: Throwable) {
                Log.w(TAG, "Could not query processor liveness; continuing bounded wait", error)
                // Unknown, not confirmed dead: keep polling rather than
                // racing an old process teardown, same as MainActivity's
                // equivalent check.
                true
            }
        }
        val timedOut = android.os.SystemClock.elapsedRealtime() >= deadlineElapsedRealtimeMs
        if (stillAlive && !timedOut) {
            monitorHandler?.postDelayed({
                awaitProcessorDeathThenRestart(targetPid, config, deadlineElapsedRealtimeMs)
            }, PROCESSOR_DEATH_POLL_INTERVAL_MS)
            return
        }
        if (timedOut && stillAlive) {
            Log.w(TAG, "Processor death is unconfirmed; pausing without relaunch pid=$targetPid")
            StackStatusStore.update(config.statusPath) { json ->
                if (json.optString("state", "") in setOf("completed", "failed", "cancelled")) {
                    false
                } else {
                    json.put("state", "interruptedRecoverable")
                    json.put("stage", "旧処理の終了確認待ち")
                    json.put("error", "旧処理プロセスの終了を確認できません。再開前に端末の処理状態を確認してください。")
                    json.put("recoveryCause", "external-resource-pause")
                    json.put("updatedEpochMs", System.currentTimeMillis())
                    true
                }
            }
            restartInProgress = false
            restartMarker(config.statusPath).delete()
            maintenanceRestartMarker(config.statusPath).delete()
            stopSupervisor(clearConfig = false)
            return
        }
        monitorHandler?.postDelayed({
            try {
                val processorIntent = ProcessorService.createIntent(
                    context = this,
                    taskName = config.taskName,
                    payloadPath = config.payloadPath,
                    statusPath = config.statusPath,
                    uniqueName = config.uniqueName,
                    jobId = config.jobId,
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(processorIntent)
                } else {
                    startService(processorIntent)
                }
                startedAtMs = System.currentTimeMillis()
            } catch (error: Throwable) {
                Log.e(TAG, "Explicit processor relaunch failed", error)
                if (isForegroundStartNotAllowed(error)) {
                    // The 96-attempt FGS-budget wait-retry route
                    // (scheduleForegroundServiceBudgetRetry) only re-engages
                    // when poll() next sees state=interruptedRecoverable with
                    // an FGS-budget cause. Without this write, the state this
                    // function set earlier (queued, via updateRecoveryFields)
                    // stands, the processor never actually starts, and the
                    // next poll() falls through to the ordinary automatic-
                    // recovery path instead — capped at
                    // MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE (2) attempts, not
                    // built for a condition that can legitimately take hours
                    // to clear. Writing the FGS-budget cause back here keeps
                    // this failure on the long-wait route where it belongs.
                    try {
                        if (wouldDowngradeState(config.statusPath, "interruptedRecoverable")) {
                            return@postDelayed
                        }
                        val json = readStatus(config.statusPath) ?: JSONObject()
                        json.put("state", "interruptedRecoverable")
                        json.put("stage", "Androidの長時間処理制限により再起動を拒否されました・再試行待ち")
                        json.put("updatedEpochMs", System.currentTimeMillis())
                        json.put("progressEpochMs", System.currentTimeMillis())
                        json.put("recoveryCause", "processor-restart-fgs-denied")
                        writeJsonAtomically(File(config.statusPath), json, ".fgs-relaunch-denied")
                    } catch (writeError: Throwable) {
                        Log.e(TAG, "Could not persist FGS-relaunch-denied status", writeError)
                    }
                }
            } finally {
                restartInProgress = false
            }
        }, PROCESSOR_DEATH_SETTLE_MS)
    }

    private fun isForegroundStartNotAllowed(error: Throwable): Boolean {
        if (error.javaClass.simpleName == "ForegroundServiceStartNotAllowedException") return true
        val message = error.message ?: return false
        return message.contains("startForegroundService() not allowed", ignoreCase = true) ||
            message.contains("mAllowStartForeground false", ignoreCase = true)
    }

    private fun processorPid(): Int? = try {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val processorName = "$packageName:processor"
        manager.runningAppProcesses?.firstOrNull { it.processName == processorName }?.pid?.takeIf { it > 0 }
    } catch (_: Throwable) { null }

    private fun recoverySignature(config: Config, status: JSONObject?): String {
        try {
            val journal = File(File(config.statusPath).parentFile, "processor_operation_journal.json")
            if (journal.isFile) {
                val root = JSONObject(journal.readText())
                val events = root.optJSONArray("events")
                if (events != null && events.length() > 0) {
                    val last = events.optJSONObject(events.length() - 1)
                    if (last != null && last.optString("event") == "ENTER") {
                        return buildString {
                            append(last.optString("operation", "unknown"))
                            append("|stage=").append(last.optString("stage", ""))
                            if (last.has("frameIndex")) append("|frame=").append(last.optInt("frameIndex"))
                            if (last.has("committedItems")) append("|committed=").append(last.optInt("committedItems"))
                        }
                    }
                }
            }
        } catch (_: Throwable) { }
        // Do not include `stage`: updateRecoveryFields() intentionally changes
        // it on each attempt. Using it here would manufacture a new signature
        // and reset the retry cap when the journal is absent or corrupt.
        return "task=${config.taskName}|item=${status?.optInt("currentItem", -1) ?: -1}" +
            "|checkpoint=${status?.optInt("recoverableCheckpointItems", 0) ?: 0}"
    }

    private fun retryLedgerFile(statusPath: String) = File("$statusPath.recovery-policy.json")

    private fun readRetryLedger(statusPath: String): RetryLedger? = try {
        val file = retryLedgerFile(statusPath)
        if (!file.isFile) null else JSONObject(file.readText()).let {
            RetryLedger(
                signature = it.optString("signature", ""),
                attempts = it.optInt("attempts", 0),
                lastReason = it.optString("lastReason", ""),
                updatedEpochMs = it.optLong("updatedEpochMs", 0L),
            )
        }
    } catch (_: Throwable) { null }

    private fun writeRetryLedger(statusPath: String, ledger: RetryLedger): Boolean {
        return try {
            val json = JSONObject()
                .put("version", 1)
                .put("signature", ledger.signature)
                .put("attempts", ledger.attempts)
                .put("maxAutomaticRestartsPerSignature", MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE)
                .put("lastReason", ledger.lastReason)
                .put("updatedEpochMs", ledger.updatedEpochMs)
            writeJsonAtomically(retryLedgerFile(statusPath), json, ".recovery-policy")
            true
        } catch (error: Throwable) {
            Log.e(TAG, "Could not persist retry ledger", error)
            false
        }
    }

    private fun clearRetryLedger(statusPath: String) {
        try { retryLedgerFile(statusPath).delete() } catch (_: Throwable) { }
        try { File("$statusPath.recovery-backoff.json").delete() } catch (_: Throwable) { }
    }

    private fun updateRecoveryFields(
        statusPath: String,
        attempt: Int,
        cause: String,
        stage: String,
        maxAttempts: Int = MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE,
    ) {
        if (wouldDowngradeState(statusPath, "queued")) {
            Log.w(TAG, "Skipping recovery-queued status write: a higher-authority state is on disk")
            return
        }
        try {
            val file = File(statusPath)
            val json = if (file.isFile) JSONObject(file.readText()) else JSONObject()
            json.put("state", "queued")
            json.put("stage", stage)
            json.put("updatedEpochMs", System.currentTimeMillis())
            json.put("progressEpochMs", System.currentTimeMillis())
            json.put("recoveryAttempt", attempt)
            json.put("recoveryMaxAttempts", maxAttempts)
            json.put("recoveryCause", cause)
            writeJsonAtomically(file, json, ".recovery-status")
        } catch (error: Throwable) {
            Log.e(TAG, "Could not persist recovery status", error)
        }
    }

    private fun clearRecoveryFields(statusPath: String) {
        try {
            val file = File(statusPath)
            if (!file.isFile) return
            val json = JSONObject(file.readText())
            json.put("recoveryAttempt", 0)
            json.put("recoveryMaxAttempts", MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE)
            json.remove("recoveryCause")
            writeJsonAtomically(file, json, ".recovery-reset")
        } catch (_: Throwable) { }
    }

    /** Android 11+ process-death evidence for ANR/OOM/native crash/etc. */
    private fun captureLatestProcessorExit(config: Config) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val processorName = "$packageName:processor"
            val latest = manager.getHistoricalProcessExitReasons(packageName, 0, 32)
                .asSequence()
                .filter { it.processName == processorName }
                .maxByOrNull { it.timestamp }
                ?: return
            if (latest.timestamp <= lastCapturedExitTimestampMs) return
            lastCapturedExitTimestampMs = latest.timestamp

            val reasonText = exitReasonName(latest.reason)
            val record = JSONObject()
                .put("timestampEpochMs", latest.timestamp)
                .put("processName", latest.processName)
                .put("reason", reasonText)
                .put("reasonCode", latest.reason)
                .put("status", latest.status)
                .put("importance", latest.importance)
                .put("pssKb", latest.pss)
                .put("rssKb", latest.rss)
            latest.description?.takeIf { it.isNotBlank() }?.let { record.put("description", it) }
            appendExitDiagnostic(config.statusPath, record)
            mergeExitIntoStatus(config.statusPath, reasonText, latest.timestamp)
            Log.w(TAG, "Processor previous exit: $reasonText status=${latest.status}")
        } catch (error: Throwable) {
            Log.w(TAG, "ApplicationExitInfo collection failed", error)
        }
    }

    private fun appendExitDiagnostic(statusPath: String, record: JSONObject) {
        val file = File(File(statusPath).parentFile, "processor_exit_diagnostics.json")
        val root = try { if (file.isFile) JSONObject(file.readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
        val events = root.optJSONArray("events") ?: JSONArray()
        events.put(record)
        while (events.length() > MAX_EXIT_EVENTS) events.remove(0)
        root.put("version", 1)
        root.put("updatedEpochMs", System.currentTimeMillis())
        root.put("events", events)
        writeJsonAtomically(file, root, ".exit-diagnostics")
    }

    private fun mergeExitIntoStatus(statusPath: String, reason: String, timestamp: Long) {
        try {
            val file = File(statusPath)
            if (!file.isFile) return
            val json = JSONObject(file.readText())
            json.put("lastProcessorExitReason", reason)
            json.put("lastProcessorExitTimestampMs", timestamp)
            writeJsonAtomically(file, json, ".exit-status")
        } catch (_: Throwable) { }
    }

    private fun exitReasonName(reason: Int): String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        when (reason) {
            ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
            ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
            ApplicationExitInfo.REASON_CRASH -> "CRASH"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
            ApplicationExitInfo.REASON_ANR -> "ANR"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
            ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
            ApplicationExitInfo.REASON_OTHER -> "OTHER"
            else -> "UNKNOWN_$reason"
        }
    } else "UNAVAILABLE"

    private fun writeJsonAtomically(file: File, json: JSONObject, suffix: String) {
        if (suffix in setOf(".supervisor-pause", ".fgs-relaunch-denied", ".recovery-status", ".recovery-reset", ".exit-status")) {
            StackStatusStore.writeSnapshot(file.path, json, resume = false)
            return
        }
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}$suffix.tmp.${Process.myPid()}")
        temp.writeText(json.toString())
        // A rename() failure previously fell back to writing directly against the
        // live status file — non-atomic, so a process death
        // mid-write could leave status.json truncated/corrupted rather than merely
        // stale. Retry once after removing an existing destination (handles the
        // rare rename-fails-if-destination-exists case on some filesystems); if it
        // still fails, leave the previous file untouched rather than corrupt it.
        val renamed = temp.renameTo(file)
        if (!renamed) {
            Log.e(TAG, "Could not atomically update status file; keeping previous contents")
            try { temp.delete() } catch (_: Throwable) { }
        }
    }

    private fun readStatus(path: String): JSONObject? = try {
        val file = File(path)
        if (!file.isFile) null else JSONObject(file.readText())
    } catch (_: Throwable) { null }

    private fun restartMarker(statusPath: String) = File("$statusPath.supervisor-restart")
    private fun maintenanceRestartMarker(statusPath: String) =
        File("$statusPath.supervisor-maintenance-restart")

    private fun configFromIntent(intent: Intent?): Config? {
        if (intent == null) return null
        val taskName = intent.getStringExtra(EXTRA_TASK_NAME)
        val payloadPath = intent.getStringExtra(EXTRA_PAYLOAD_PATH)
        val statusPath = intent.getStringExtra(EXTRA_STATUS_PATH)
        val uniqueName = intent.getStringExtra(EXTRA_UNIQUE_NAME)
        val jobId = intent.getStringExtra(EXTRA_JOB_ID)
        if (taskName.isNullOrBlank() || payloadPath.isNullOrBlank() ||
            statusPath.isNullOrBlank() || uniqueName.isNullOrBlank() || jobId.isNullOrBlank()) return null
        return Config(taskName, payloadPath, statusPath, uniqueName, jobId)
    }

    private fun persistConfig(config: Config) {
        try {
            val json = JSONObject()
                .put("taskName", config.taskName)
                .put("payloadPath", config.payloadPath)
                .put("statusPath", config.statusPath)
                .put("uniqueName", config.uniqueName)
                .put("jobId", config.jobId)
            writeJsonAtomically(configFile(), json, ".config")
        } catch (error: Throwable) {
            Log.e(TAG, "Could not persist supervisor config", error)
        }
    }

    private fun readPersistedConfig(): Config? = try {
        val file = configFile()
        if (!file.isFile) null else JSONObject(file.readText()).let { json ->
            Config(
                json.getString("taskName"),
                json.getString("payloadPath"),
                json.getString("statusPath"),
                json.getString("uniqueName"),
                json.getString("jobId"),
            )
        }
    } catch (_: Throwable) { null }

    private fun configFile(): File = File(filesDir, "processor_supervisor/active_job.json")

    private fun stopSupervisor(clearConfig: Boolean) {
        activeConfig = null
        fgsBudgetRetryScheduledForStatusPath = null
        monitorHandler?.removeCallbacksAndMessages(null)
        if (clearConfig) try { configFile().delete() } catch (_: Throwable) { }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "処理システム監視", NotificationManager.IMPORTANCE_LOW).apply {
                description = "画像処理システムの停止検出と自動復旧を行います"
                setSound(null, null)
            },
        )
    }

    private fun updateSupervisorNotification(text: String) {
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(text))
        } catch (_: Throwable) { }
    }

    private fun buildNotification(text: String): Notification {
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        @Suppress("DEPRECATION")
        // Work359: tapping the supervisor notification opens the app (where the
        // job status and the resume control are).
        val openApp = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Mobile Stack")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openApp)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_MIN)
            .build()
    }

    companion object {
        private const val TAG = "MobileStackSupervisor"
        private const val CHANNEL_ID = "processor_supervisor"
        private const val NOTIFICATION_ID = 41002
        private const val POLL_INTERVAL_MS = 5_000L
        private const val PROCESSOR_MISSING_GRACE_MS = 20_000L
        // Mirrors MainActivity's constants of the same name/values.
        private const val PROCESSOR_DEATH_POLL_INTERVAL_MS = 100L
        private const val PROCESSOR_DEATH_SETTLE_MS = 250L
        private const val PROCESSOR_DEATH_MAX_WAIT_MS = 5000L
        private const val HARD_STALE_FALLBACK_MS = 35L * 60L * 1000L
        private const val MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE = 2
        private const val MAX_EXIT_EVENTS = 16
        // Mirrors ForegroundTimeoutRecovery.recoverableCauses on the Dart
        // side: all three mean "Android would not let this session run or
        // restart, but every checkpoint is safe" rather than an actual
        // processing failure.
        private val FGS_BUDGET_RECOVERY_CAUSES = setOf(
            "foreground-service-timeout",
            "processor-restart-fgs-denied",
            "processor-launch-unconfirmed",
        )
        private const val MAX_FGS_BUDGET_WAIT_RETRIES = 96

        private const val EXTRA_TASK_NAME = "taskName"
        private const val EXTRA_PAYLOAD_PATH = "payloadPath"
        private const val EXTRA_STATUS_PATH = "statusPath"
        private const val EXTRA_UNIQUE_NAME = "uniqueName"
        private const val EXTRA_JOB_ID = "jobId"
        private const val EXTRA_RESET_RETRY_BUDGET = "resetRetryBudget"

        fun createIntent(
            context: Context,
            taskName: String,
            payloadPath: String,
            statusPath: String,
            uniqueName: String,
            jobId: String,
            resetRetryBudget: Boolean = false,
        ): Intent = Intent(context, SupervisorService::class.java).apply {
            putExtra(EXTRA_TASK_NAME, taskName)
            putExtra(EXTRA_PAYLOAD_PATH, payloadPath)
            putExtra(EXTRA_STATUS_PATH, statusPath)
            putExtra(EXTRA_UNIQUE_NAME, uniqueName)
            putExtra(EXTRA_JOB_ID, jobId)
            putExtra(EXTRA_RESET_RETRY_BUDGET, resetRetryBudget)
        }
    }
}
