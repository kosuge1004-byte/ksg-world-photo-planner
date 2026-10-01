package com.mobilestack.app

import android.app.NotificationChannel
import android.content.IntentFilter
import android.os.PowerManager
import android.os.Debug
import android.os.BatteryManager
import android.app.ActivityManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Bundle
import android.os.ResultReceiver
import android.util.Log
import android.app.Notification
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.File
import java.util.ArrayDeque

/**
 * Heavy image-processing host that runs in the manifest-declared `:processor`
 * OS process.  The app UI remains in the default process.
 *
 * The service owns a dedicated FlutterEngine and launches `processorMain`
 * rather than the normal UI entry point.  Progress/control is intentionally
 * file-backed (status.json / cancellation marker), so the two processes do not
 * share mutable Dart state or locks.
 */
class ProcessorService : Service() {
    private var engine: FlutterEngine? = null
    private var runtimeChannel: MethodChannel? = null
    private var runtimeReady = false
    private var taskRunning = false
    private var foregroundStarted = false
    private var wakeLock: PowerManager.WakeLock? = null
    private data class PendingLaunch(
        val intent: Intent,
        val receivers: MutableList<ResultReceiver> = mutableListOf(),
    )
    private val pendingLaunches = ArrayDeque<PendingLaunch>()
    private var activeLaunch: PendingLaunch? = null
    private var activeStatusPath: String? = null

    override fun onCreate() {
        super.onCreate()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_REDELIVER_INTENT
        val copiedIntent = Intent(intent)
        val statusPath = copiedIntent.getStringExtra(EXTRA_STATUS_PATH)
        if (!statusPath.isNullOrBlank() && File("$statusPath.abandon").isFile) {
            copiedIntent.launchReceiver()?.send(
                RESULT_LAUNCH_FAILED,
                Bundle().apply { putString(RESULT_ERROR_MESSAGE, "このジョブは破棄されています。") },
            )
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // Defense-in-depth alongside StackJobReporter.start()'s own check on
        // the Dart side: this Service returns START_REDELIVER_INTENT, so if
        // the OS kills :processor after a job finished but before Android
        // recorded stopSelf(), the last Intent can be redelivered here.
        // Checking before even standing up the Flutter engine means a
        // redelivered Intent for an already-finished job costs a cheap file
        // read instead of relaunching the whole native/Dart processing
        // stack just to have the Dart-side check reject it a moment later.
        if (!statusPath.isNullOrBlank()) {
            val existingState = try {
                File(statusPath).takeIf { it.isFile }
                    ?.let { JSONObject(it.readText()).optString("state", "") }
            } catch (_: Throwable) {
                null
            }
            if (existingState == "completed" || existingState == "failed" ||
                existingState == "cancelled") {
                Log.i(TAG, "Ignoring redelivered intent for already-$existingState job")
                stopSelf(startId)
                return START_NOT_STICKY
            }
        }
        if (!foregroundStarted) {
            try {
                ensureNotificationChannel()
                startForeground(
                    NOTIFICATION_ID,
                    buildBootstrapNotification("画像処理システムを起動中"),
                )
                foregroundStarted = true
                acquireProcessingWakeLock()
            } catch (error: Throwable) {
                if (isForegroundServiceTimeLimitExhausted(error)) {
                    // Android 15+: this app's mediaProcessing background-
                    // execution budget for the current rolling window was
                    // already fully spent *before* this attempt even
                    // started (e.g. an earlier session today ran long).
                    // startForeground() then fails synchronously instead of
                    // onTimeout() ever firing. Durable checkpoints from any
                    // prior run are untouched on disk, so this is the same
                    // recoverable situation onTimeout() handles — persist it
                    // the same way so a resumable job doesn't look like a
                    // dead end. Still notify the launch receiver (as the
                    // generic branch below does) so MainActivity's own
                    // bookkeeping — including its `isRestart`-aware
                    // recoverable handling in failProcessorLaunch — runs
                    // immediately rather than waiting out the ack timeout.
                    Log.w(TAG, "Foreground-service budget already exhausted at startup", error)
                    writeSystemTimeoutRecoverable(statusPath, fgsType = -1)
                    // Work359: this also happens on SupervisorService's
                    // background retries, where nobody is looking at the
                    // app. Same notification ID, alert-once: no repeat buzz.
                    postResumeNeededNotification()
                    copiedIntent.launchReceiver()?.send(
                        RESULT_LAUNCH_FAILED,
                        Bundle().apply {
                            putString(RESULT_ERROR_CODE, ERROR_FGS_BUDGET_EXHAUSTED)
                            putString(RESULT_ERROR_MESSAGE, error.message)
                        },
                    )
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                Log.e(TAG, "Could not promote processor to foreground", error)
                writeBootstrapFailure(statusPath, error)
                copiedIntent.launchReceiver()?.send(
                    RESULT_LAUNCH_FAILED,
                    Bundle().apply { putString(RESULT_ERROR_MESSAGE, error.message) },
                )
                stopSelf(startId)
                return START_NOT_STICKY
            }
        }
        enqueueLaunch(copiedIntent)
        if (engine == null) {
            startFlutterRuntime()
        } else {
            dispatchIfReady()
        }
        // If Android kills only the processor under memory pressure, ask it to
        // redeliver the exact task intent. Persistent frame checkpoints decide
        // how much work must actually be repeated.
        return START_REDELIVER_INTENT
    }

    private fun isForegroundServiceTimeLimitExhausted(error: Throwable): Boolean {
        val message = error.message ?: return false
        return message.contains("Time limit already exhausted", ignoreCase = true)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Android 15+ gives mediaProcessing foreground services a finite
     * background execution budget.  When the OS exhausts that budget, persist
     * a recoverable state *without* a supervisor restart marker, then stop the
     * service within the platform grace period.  An immediate automatic
     * restart would simply hit the already-exhausted quota again.  The user can
     * foreground the app and resume from the durable checkpoint.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground-service execution budget exhausted; pausing recoverably")
        writeSystemTimeoutRecoverable(activeStatusPath, fgsType)
        failPendingLaunches("Androidの長時間処理制限により起動を完了できませんでした。")
        // Replace notification 41001 (the ongoing "processing..." one, if
        // still showing) before detaching, or it is left stuck exactly as
        // it was — see buildPausedNotification's doc comment.
        postResumeNeededNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_DETACH)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(false)
        }
        stopSelf(startId)
    }

    override fun onDestroy() {
        failPendingLaunches("画像処理システムが起動確認前に終了しました。")
        runtimeChannel?.setMethodCallHandler(null)
        runtimeChannel = null
        engine?.destroy()
        engine = null
        releaseProcessingWakeLock()
        super.onDestroy()
    }

    /**
     * A `mediaProcessing` foreground service does not, by itself, guarantee
     * the CPU keeps running once the screen turns off — that guarantee
     * specifically requires a wake lock. Without one, a screen-off/idle/Doze
     * stretch during a many-hour star-trail/Milky-Way run risked the CPU
     * being suspended mid-job even though the (correctly-declared, visibly
     * running) foreground service itself was never killed — a different
     * failure mode from anything an FGS timeout or process death produces,
     * and one none of the recovery paths in this file are built to detect
     * or resume from, since nothing "fails" in a way that produces a status
     * write. Held only while this Service is actually promoted to
     * foreground (never across `onCreate`/before `startForeground()`
     * succeeds, and always released in `onDestroy()`, so a crash or normal
     * completion cannot leak it), and acquired with a bounded timeout as a
     * defensive backstop against exactly that kind of missed-release bug —
     * `acquire()` with no timeout is a common source of the battery-drain
     * reports Android's WakeLock guidance warns about. The timeout
     * (WAKE_LOCK_TIMEOUT_MS) is set comfortably beyond the mediaProcessing
     * budget's own ~6-hour single-session ceiling, so it never expires
     * during a legitimate session — onTimeout()/the OS would end the
     * session first — while still bounding worst-case drain from a missed
     * release to a single timeout window instead of indefinitely.
     */
    private fun acquireProcessingWakeLock() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "MobileStack:processorWakeLock",
            ).also { it.setReferenceCounted(false) }
            wakeLock = lock
            lock.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (error: Throwable) {
            Log.w(TAG, "Could not acquire processing wake lock", error)
        }
    }

    private fun releaseProcessingWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (error: Throwable) {
            Log.w(TAG, "Could not release processing wake lock", error)
        } finally {
            wakeLock = null
        }
    }

    private fun Intent.launchReceiver(): ResultReceiver? = if (Build.VERSION.SDK_INT >= 33) {
        getParcelableExtra(EXTRA_LAUNCH_RECEIVER, ResultReceiver::class.java)
    } else {
        @Suppress("DEPRECATION")
        getParcelableExtra(EXTRA_LAUNCH_RECEIVER)
    }

    private fun enqueueLaunch(intent: Intent) {
        val jobId = intent.getStringExtra(EXTRA_JOB_ID)
        val receiver = intent.launchReceiver()
        val taskName = intent.getStringExtra(EXTRA_TASK_NAME)
        val payloadPath = intent.getStringExtra(EXTRA_PAYLOAD_PATH)
        val statusPath = intent.getStringExtra(EXTRA_STATUS_PATH)
        val existing = sequenceOf(activeLaunch)
            .plus(pendingLaunches.asSequence())
            .filterNotNull()
            .firstOrNull {
                it.intent.getStringExtra(EXTRA_JOB_ID) == jobId &&
                    it.intent.getStringExtra(EXTRA_TASK_NAME) == taskName &&
                    it.intent.getStringExtra(EXTRA_PAYLOAD_PATH) == payloadPath &&
                    it.intent.getStringExtra(EXTRA_STATUS_PATH) == statusPath
            }
        if (existing != null) {
            if (receiver != null) existing.receivers.add(receiver)
            if (existing === activeLaunch && taskRunning) acknowledgeLaunch(existing)
            return
        }
        pendingLaunches.addLast(
            PendingLaunch(intent).also { launch ->
                if (receiver != null) launch.receivers.add(receiver)
            },
        )
    }

    private fun acknowledgeLaunch(launch: PendingLaunch) {
        launch.receivers.toList().forEach { receiver ->
            try { receiver.send(RESULT_LAUNCH_ACCEPTED, Bundle.EMPTY) } catch (_: Throwable) { }
        }
        launch.receivers.clear()
    }

    private fun failPendingLaunches(message: String) {
        val launches = buildList {
            activeLaunch?.let(::add)
            addAll(pendingLaunches)
        }
        launches.forEach { launch ->
            launch.receivers.forEach { receiver ->
                try {
                    receiver.send(
                        RESULT_LAUNCH_FAILED,
                        Bundle().apply { putString(RESULT_ERROR_MESSAGE, message) },
                    )
                } catch (_: Throwable) { }
            }
            launch.receivers.clear()
        }
        pendingLaunches.clear()
    }

    private fun startFlutterRuntime() {
        try {
            val loader = FlutterInjector.instance().flutterLoader()
            if (!loader.initialized()) {
                loader.startInitialization(applicationContext)
            }
            loader.ensureInitializationComplete(applicationContext, null)
            val flutterEngine = FlutterEngine(applicationContext)
            engine = flutterEngine
            StackStatusStore.attach(flutterEngine.dartExecutor.binaryMessenger)
            val channel = MethodChannel(
                flutterEngine.dartExecutor.binaryMessenger,
                RUNTIME_CHANNEL,
            )
            runtimeChannel = channel
            MethodChannel(
                flutterEngine.dartExecutor.binaryMessenger,
                DEVICE_RESOURCES_CHANNEL,
            ).setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
                when (call.method) {
                    "readResourceSnapshot" -> result.success(readResourceSnapshot())
                    else -> result.notImplemented()
                }
            }
            channel.setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
                when (call.method) {
                    "runtimeReady" -> {
                        runtimeReady = true
                        result.success(null)
                        dispatchIfReady()
                    }
                    else -> result.notImplemented()
                }
            }
            flutterEngine.dartExecutor.executeDartEntrypoint(
                DartExecutor.DartEntrypoint(
                    loader.findAppBundlePath(),
                    "package:mobile_stack/core/background/processor_runtime.dart",
                    "processorMain",
                ),
            )
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to start processor Flutter runtime", error)
            pendingLaunches.forEach { launch ->
                writeBootstrapFailure(
                    launch.intent.getStringExtra(EXTRA_STATUS_PATH),
                    error,
                )
            }
            failPendingLaunches(error.message ?: "画像処理ランタイムを起動できませんでした。")
            finishForegroundService()
        }
    }

    private fun dispatchIfReady() {
        if (!runtimeReady || taskRunning) return
        val launch = pendingLaunches.pollFirst() ?: return
        activeLaunch = launch
        val intent = launch.intent
        val taskName = intent.getStringExtra(EXTRA_TASK_NAME)
        val payloadPath = intent.getStringExtra(EXTRA_PAYLOAD_PATH)
        val statusPath = intent.getStringExtra(EXTRA_STATUS_PATH)
        if (taskName.isNullOrBlank() || payloadPath.isNullOrBlank()) {
            val error = IllegalArgumentException("Processor task payload is missing")
            writeBootstrapFailure(statusPath, error)
            failPendingLaunches(error.message ?: "Processor task payload is missing")
            activeLaunch = null
            if (pendingLaunches.isEmpty()) finishForegroundService() else dispatchIfReady()
            return
        }

        activeStatusPath = statusPath
        taskRunning = true
        acknowledgeLaunch(launch)
        val args = hashMapOf<String, Any>(
            "taskName" to taskName,
            "payloadPath" to payloadPath,
            "statusPath" to (statusPath ?: ""),
        )
        runtimeChannel?.invokeMethod("execute", args, object : MethodChannel.Result {
            override fun success(result: Any?) {
                taskRunning = false
                activeLaunch = null
                val success = result as? Boolean ?: false
                if (!success) {
                    Log.w(TAG, "Processor task requested retry/failure: $taskName")
                }
                // A recoverable worker failure has already persisted verified
                // checkpoints and a supervisor-restart marker. Keep this
                // started foreground service alive until the independent
                // :supervisor kills only :processor. Because this service
                // returned START_REDELIVER_INTENT, Android can then recreate
                // it with the original task intent. Calling stopSelf() here
                // would cancel that redelivery path and make background
                // automatic recovery impossible.
                if (shouldAwaitSupervisorRecovery(statusPath)) {
                    Log.w(TAG, "Recoverable task failure; awaiting supervisor restart")
                    return
                }
                if (pendingLaunches.isEmpty()) finishForegroundService() else dispatchIfReady()
            }

            override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                taskRunning = false
                val error = IllegalStateException("$errorCode: ${errorMessage ?: "processor task failed"}")
                Log.e(TAG, "Processor Dart task failed", error)
                writeBootstrapFailure(statusPath, error)
                activeLaunch = null
                if (pendingLaunches.isEmpty()) finishForegroundService() else dispatchIfReady()
            }

            override fun notImplemented() {
                taskRunning = false
                val error = IllegalStateException("Processor Dart runtime did not implement execute")
                writeBootstrapFailure(statusPath, error)
                activeLaunch = null
                if (pendingLaunches.isEmpty()) finishForegroundService() else dispatchIfReady()
            }
        })
    }


    // Same fallback-optimism problem as MainActivity's readResourceSnapshot,
    // fixed the same way there and here independently because :processor is
    // a separate OS process and cannot call MainActivity's copy — a failed
    // reading is the one moment this code has no idea what state the
    // device is in, so it should not also be the one moment every
    // concurrency guard stands down. See MainActivity.kt's copy for the
    // fuller comment.
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
            // /proc plus Dart fallbacks remain available.
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
        } catch (_: Throwable) {}

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
                    else -> 0.5
                }
            } catch (_: Throwable) {
                0.5
            }
        } else {
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

    private fun shouldAwaitSupervisorRecovery(statusPath: String?): Boolean {
        if (statusPath.isNullOrBlank()) return false
        return try {
            val statusFile = File(statusPath)
            val restartMarker = File("$statusPath.supervisor-restart")
            val maintenanceMarker = File("$statusPath.supervisor-maintenance-restart")
            if (!statusFile.isFile || (!restartMarker.isFile && !maintenanceMarker.isFile)) {
                return false
            }
            val state = JSONObject(statusFile.readText()).optString("state", "")
            state == "interruptedRecoverable"
        } catch (_: Throwable) {
            false
        }
    }

    private fun finishForegroundService() {
        if (foregroundStarted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // Dart may already have replaced the progress notification with a
            // completion/failure notification using the same ID. Detach rather
            // than remove it when the processor process exits.
            stopForeground(STOP_FOREGROUND_DETACH)
        } else if (foregroundStarted) {
            @Suppress("DEPRECATION")
            stopForeground(false)
        }
        foregroundStarted = false
        stopSelf()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "スタック処理",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "長時間の画像処理の進捗を表示します"
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildBootstrapNotification(text: String): Notification {
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        @Suppress("DEPRECATION")
        return builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Mobile Stack")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
            .build()
    }

    // Distinct from buildBootstrapNotification: not ongoing (the user can
    // dismiss it, since nothing is actively running to protect from
    // swipe-away) and no PRIORITY_LOW throttling concern either way. Used
    // when this service stops but the job is not finished — most notably
    // onTimeout(), which used to leave the "processing..." notification
    // (id 41001, ongoing) untouched via stopForeground(DETACH): DETACH only
    // drops the notification's association with *this* Service instance, it
    // does not update or clear the notification itself, so the person would
    // see "processing" indefinitely for a job that had actually paused.
    // Work359: the paused notification is the person's only cue that a job
    // needs them (Android only resets an exhausted mediaProcessing budget
    // after the app is opened). It therefore goes to a separate
    // default-importance channel (the processing channel is LOW: silent, no
    // status-bar prominence) and opens the app when tapped; opening the app
    // triggers the existing automatic resume (and Work352's :processor
    // foreground reset when needed).
    private fun buildPausedNotification(text: String): Notification {
        ensureAttentionChannel()
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, ATTENTION_CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        @Suppress("DEPRECATION")
        return builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("処理を一時停止しました")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openAppPendingIntent())
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setOngoing(false)
            .setPriority(Notification.PRIORITY_DEFAULT)
            .build()
    }

    private fun openAppPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        return PendingIntent.getActivity(
            this,
            ATTENTION_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun ensureAttentionChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(
                    ATTENTION_CHANNEL_ID,
                    "処理の再開が必要",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Androidの制限で処理が一時停止し、アプリを開く必要があるときに通知します"
                },
            )
        } catch (error: Throwable) {
            Log.w(TAG, "Could not create attention notification channel", error)
        }
    }

    private fun postResumeNeededNotification() {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(
                NOTIFICATION_ID,
                buildPausedNotification(RESUME_NEEDED_TEXT),
            )
        } catch (error: Throwable) {
            Log.w(TAG, "Could not post resume-needed notification", error)
        }
    }

    private fun writeSystemTimeoutRecoverable(statusPath: String?, fgsType: Int) {
        if (statusPath.isNullOrBlank()) return
        // Same cross-process status.json race guarded against on the Dart
        // side (StackJobStatus._stateRank) and in SupervisorService
        // (stateRank/wouldDowngradeState): without it, this recoverable
        // write could stomp a "completed"/"failed"/"cancelled" state a
        // different process wrote a moment earlier.
        try {
            val existingState = File(statusPath).takeIf { it.isFile }
                ?.let { JSONObject(it.readText()).optString("state", "") }
            if (existingState == "completed" || existingState == "failed" ||
                existingState == "cancelled") {
                Log.w(TAG, "Skipping timeout-recoverable status write: state=$existingState already terminal")
                return
            }
        } catch (_: Throwable) {
            // Unreadable/unparsable existing file: nothing to protect
            // against overwriting, so proceed with the normal write below.
        }
        try {
            val file = File(statusPath)
            val json = if (file.isFile) JSONObject(file.readText()) else JSONObject()
            json.put("state", "interruptedRecoverable")
            json.put("stage", "Android長時間処理制限・アプリ復帰時に自動再開")
            json.put("updatedEpochMs", System.currentTimeMillis())
            json.put("progressEpochMs", System.currentTimeMillis())
            json.put("recoveryCause", "foreground-service-timeout")
            json.put(
                "error",
                "Androidのフォアグラウンドサービス実行時間上限に達しました。" +
                    "保存済みチェックポイントは保持されています。" +
                    "保存済み地点から継続できます。アプリを開くと自動再開します" +
                    "（再開できない場合は端末の再起動、または24時間後に再開できます）。 fgsType=" +
                        (if (fgsType >= 0) fgsType.toString() else "unknown(exhausted-before-start)"),
            )
            // Never create a supervisor-restart marker here. Android 15 keeps
            // the exhausted quota across service restarts until the budget is
            // reset, so an automatic restart loop cannot make forward progress.
            StackStatusStore.writeSnapshot(statusPath, json, resume = false)
        } catch (error: Throwable) {
            Log.e(TAG, "Could not persist foreground-service timeout state", error)
        }
    }

    /** Best-effort terminal status for failures before Dart's reporter exists. */
    private fun writeBootstrapFailure(statusPath: String?, error: Throwable) {
        if (statusPath.isNullOrBlank()) return
        try {
            val file = File(statusPath)
            val json = if (file.isFile) JSONObject(file.readText()) else JSONObject()
            json.put("state", "failed")
            json.put("stage", "処理システム起動エラー")
            json.put("updatedEpochMs", System.currentTimeMillis())
            json.put("progressEpochMs", System.currentTimeMillis())
            json.put("error", error.message ?: error.javaClass.simpleName)
            StackStatusStore.writeSnapshot(statusPath, json, resume = false)
        } catch (ignored: Throwable) {
            Log.e(TAG, "Could not persist processor bootstrap failure", ignored)
        }
    }

    companion object {
        private const val TAG = "MobileStackProcessor"
        private const val RUNTIME_CHANNEL = "com.mobilestack.app/processor_runtime"
        private const val DEVICE_RESOURCES_CHANNEL = "com.mobilestack.app/device_resources"
        private const val CHANNEL_ID = "stack_processing"
        private const val NOTIFICATION_ID = 41001
        // Work359.
        private const val ATTENTION_CHANNEL_ID = "stack_attention"
        private const val ATTENTION_REQUEST_CODE = 41001
        private const val RESUME_NEEDED_TEXT =
            "Androidの長時間処理の制限に達しました。タップしてアプリを開くと、保存済みの地点から自動で再開します。"
        // See acquireProcessingWakeLock's doc comment: comfortably beyond
        // the mediaProcessing budget's own ~6-hour single-session ceiling.
        private const val WAKE_LOCK_TIMEOUT_MS = 7L * 60L * 60L * 1000L

        const val EXTRA_TASK_NAME = "taskName"
        const val EXTRA_PAYLOAD_PATH = "payloadPath"
        const val EXTRA_STATUS_PATH = "statusPath"
        const val EXTRA_UNIQUE_NAME = "uniqueName"
        const val EXTRA_JOB_ID = "jobId"
        const val EXTRA_LAUNCH_RECEIVER = "launchReceiver"
        const val RESULT_LAUNCH_ACCEPTED = 1
        const val RESULT_LAUNCH_FAILED = 2
        const val RESULT_ERROR_CODE = "errorCode"
        const val RESULT_ERROR_MESSAGE = "errorMessage"
        const val ERROR_FGS_BUDGET_EXHAUSTED = "fgs-budget-exhausted"

        fun createIntent(
            context: Context,
            taskName: String,
            payloadPath: String,
            statusPath: String,
            uniqueName: String,
            jobId: String,
            launchReceiver: ResultReceiver? = null,
        ): Intent = Intent(context, ProcessorService::class.java).apply {
            putExtra(EXTRA_TASK_NAME, taskName)
            putExtra(EXTRA_PAYLOAD_PATH, payloadPath)
            putExtra(EXTRA_STATUS_PATH, statusPath)
            putExtra(EXTRA_UNIQUE_NAME, uniqueName)
            putExtra(EXTRA_JOB_ID, jobId)
            if (launchReceiver != null) putExtra(EXTRA_LAUNCH_RECEIVER, launchReceiver)
        }
    }
}
