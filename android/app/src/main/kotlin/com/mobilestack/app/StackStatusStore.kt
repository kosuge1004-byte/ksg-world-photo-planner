package com.mobilestack.app

import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import org.json.JSONObject

/** All Android writers use this transaction, including Dart via the channel.
 * A stable sidecar inode is locked; locking status.json itself would stop
 * protecting writers as soon as the data inode is atomically replaced.
 * synchronized also serializes threads/engines in one process (FileChannel
 * locks alone do not serialize overlapping requests in one JVM).
 */
object StackStatusStore {
    const val CHANNEL = "com.mobilestack.app/stack_status"
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val terminal = setOf("completed", "failed", "cancelled")

    @Synchronized
    fun update(path: String, change: (JSONObject) -> Boolean): JSONObject {
        val file = File(path)
        file.parentFile?.mkdirs()
        RandomAccessFile(File("$path.lock"), "rw").use { sidecar ->
            sidecar.channel.lock().use {
                // Fail closed on corrupted state. Never replace an unreadable
                // checkpoint/status with a made-up empty running job.
                val current = if (file.isFile) JSONObject(file.readText()) else JSONObject()
                val next = JSONObject(current.toString())
                if (!change(next)) return current
                val oldState = current.optString("state", "")
                if (oldState in terminal && next.optString("state", "") != oldState) return current
                next.put("revision", current.optLong("revision", 0L) + 1L)
                val temporary = File.createTempFile("${file.name}.", ".pending", file.parentFile)
                try {
                    FileOutputStream(temporary).use { stream ->
                        stream.write(next.toString().toByteArray(Charsets.UTF_8))
                        stream.fd.sync()
                    }
                    // POSIX rename replaces atomically. No delete-before-rename
                    // fallback: a killed writer must leave the old state intact.
                    Os.rename(temporary.absolutePath, file.absolutePath)
                    val directory = Os.open(file.parentFile!!.absolutePath, OsConstants.O_RDONLY, 0)
                    try { Os.fsync(directory) } finally { Os.close(directory) }
                } finally {
                    temporary.delete()
                }
                return next
            }
        }
    }

    fun writeSnapshot(path: String, snapshot: JSONObject, resume: Boolean): JSONObject = update(path) { current ->
        val expected = snapshot.optLong("revision", 0L)
        if (expected != current.optLong("revision", 0L)) return@update false
        val oldState = current.optString("state", "")
        val newState = snapshot.optString("state", "")
        if (oldState in terminal) return@update false
        if (oldState == "interruptedRecoverable" && newState in setOf("queued", "running") && !resume) return@update false
        val checkpointItems = maxOf(current.optInt("recoverableCheckpointItems", 0), snapshot.optInt("recoverableCheckpointItems", 0))
        val exitReason = current.opt("lastProcessorExitReason")
        val exitTimestamp = current.opt("lastProcessorExitTimestampMs")
        current.keys().asSequence().toList().forEach { current.remove(it) }
        snapshot.keys().forEach { key -> current.put(key, snapshot.get(key)) }
        current.put("recoverableCheckpointItems", checkpointItems)
        if (exitReason != null) current.put("lastProcessorExitReason", exitReason)
        if (exitTimestamp != null) current.put("lastProcessorExitTimestampMs", exitTimestamp)
        true
    }

    fun attach(messenger: BinaryMessenger) {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler { call, result ->
            if (call.method != "writeSnapshot") {
                result.notImplemented()
            } else {
                val path = call.argument<String>("path")
                val text = call.argument<String>("snapshot")
                val resume = call.argument<Boolean>("resume") ?: false
                if (path.isNullOrBlank() || text == null) {
                    result.error("invalid_status_arguments", "Status path and snapshot are required", null)
                } else executor.execute {
                    try {
                        val committed = writeSnapshot(path, JSONObject(text), resume).toString()
                        mainHandler.post { result.success(committed) }
                    } catch (error: Exception) {
                        mainHandler.post { result.error("status_commit_failed", error.message, null) }
                    }
                }
            }
        }
    }
}
