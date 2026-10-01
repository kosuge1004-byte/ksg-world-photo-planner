import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',
  'utf8',
);
const processor = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt',
  'utf8',
);

// Android can accept startForegroundService(), then reject the actual
// startForeground() promotion inside ProcessorService because the
// mediaProcessing 6-hour budget is exhausted. The service must classify this
// failure explicitly rather than reducing it to an opaque launch failure.
assert.match(
  processor,
  /putString\(RESULT_ERROR_CODE, ERROR_FGS_BUDGET_EXHAUSTED\)/,
  'ProcessorService must send a structured FGS-budget-exhausted failure code',
);
assert.match(
  processor,
  /const val ERROR_FGS_BUDGET_EXHAUSTED = "fgs-budget-exhausted"/,
  'the structured FGS budget failure code must be stable',
);

// MainActivity previously retried only exceptions thrown synchronously by
// startForegroundService(). A budget rejection delivered asynchronously by
// RESULT_LAUNCH_FAILED therefore went straight to processor_restart_failed.
// It must now stay pending and join the same bounded foreground retry path.
assert.match(
  main,
  /serviceErrorCode == ProcessorService\.ERROR_FGS_BUDGET_EXHAUSTED[\s\S]{0,700}state\.attempt \+= 1[\s\S]{0,500}scheduleProcessorRetry\(state\)/,
  'service-reported FGS budget exhaustion must defer and retry instead of failing immediately',
);
assert.match(
  main,
  /state\.awaitingServiceAck = false[\s\S]{0,250}state\.ackTimeout = null[\s\S]{0,900}scheduleProcessorRetry\(state\)/,
  'the failed service acknowledgement must be cleared before scheduling a retry',
);
assert.match(
  main,
  /isForegroundServiceTimeLimitExhausted\(error\)/,
  'message fallback must recognize Android Time limit already exhausted failures',
);
assert.match(
  main,
  /isForegroundStartNotAllowed\(error\) \|\|\s*isForegroundServiceTimeLimitExhausted\(error\)/,
  'synchronous start failures must also classify exhausted mediaProcessing budget as retryable',
);

console.log('Work335 service-reported FGS budget retry contract: PASS');
