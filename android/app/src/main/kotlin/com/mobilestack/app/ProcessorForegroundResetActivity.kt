package com.mobilestack.app

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * Work352: brings the `:processor` OS process to the TOP state for a moment.
 *
 * Android 15+ tracks the mediaProcessing 6h/24h budget per uid and, after a
 * timeout, only allows a new mediaProcessing FGS once
 * `ServiceRecord.app.mState.getLastTopTime() > timeLimitExceededAt`, where
 * `app` is the ProcessRecord of the process that hosts the *service*
 * (ActiveServices, "reset the time limit ... if the app was in the TOP state
 * after time limit was exhausted"). ProcessorService runs in `:processor`,
 * which never hosts an Activity, so bringing MainActivity (main process) to the
 * front never satisfies that condition; resume attempts kept failing with
 * "Time limit already exhausted" until reboot or 24 h (device report).
 *
 * This translucent, history-less Activity is declared in `:processor`. While
 * it is resumed, that process is TOP; it finishes itself after
 * [VISIBLE_MS]. MainActivity then regains window focus and its existing
 * bounded retry starts ProcessorService in the same process. The FGS type
 * stays mediaProcessing (Play policy, Work350 invariant).
 *
 * Needs on-device confirmation on each supported Android version: the
 * exact point at which the platform records lastTopTime is not observable
 * from the app.
 */
class ProcessorForegroundResetActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val finishRunnable = Runnable {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    override fun onResume() {
        super.onResume()
        handler.removeCallbacks(finishRunnable)
        handler.postDelayed(finishRunnable, VISIBLE_MS)
    }

    override fun onDestroy() {
        handler.removeCallbacks(finishRunnable)
        super.onDestroy()
    }

    companion object {
        const val VISIBLE_MS = 400L
    }
}
