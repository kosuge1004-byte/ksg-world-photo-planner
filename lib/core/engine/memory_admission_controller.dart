import 'dart:async';

import 'resource_snapshot.dart';

/// Quality-neutral memory admission and process-recycle policy.
///
/// No image dimensions, demosaic settings, stacking math, output precision or
/// export settings are ever reduced. The controller may only wait at a safe
/// boundary or ask the outer supervisor to recycle the disposable processor
/// after a durable checkpoint exists.
final class MemoryAdmissionDecision {
  const MemoryAdmissionDecision({
    required this.safeToStart,
    required this.shouldRecycleProcessor,
    required this.requiredAdditionalBytes,
    required this.memoryBudgetBytes,
    required this.snapshot,
    required this.reason,
  });

  final bool safeToStart;
  final bool shouldRecycleProcessor;
  final int requiredAdditionalBytes;
  final int memoryBudgetBytes;
  final ResourceSnapshot snapshot;
  final String reason;
}

final class MemoryAdmissionController {
  MemoryAdmissionController({
    required this.resourceReader,
    this.pollInterval = const Duration(seconds: 2),
    this.maximumAdmissionWait = const Duration(minutes: 2),
  });

  final Future<ResourceSnapshot> Function() resourceReader;
  final Duration pollInterval;
  final Duration maximumAdmissionWait;

  int? _baselineRssBytes;
  int? _lastRssBytes;
  int _monotonicGrowthSamples = 0;

  /// Conservative transient estimate for one maximum-quality full-frame RAW
  /// operation. This is intentionally an admission estimate, not an allocator:
  /// RGB float output (12 B/pixel), raw/calibration working planes and native
  /// scratch space are covered without changing any quality setting.
  static int estimateFullFrameAdditionalBytes({
    required int width,
    required int height,
  }) {
    final int pixels = width * height;
    return pixels * 24 + 256 * 1024 * 1024;
  }

  /// Estimate for post-decode combine/render/export when a full-resolution RGB
  /// checkpoint already exists. Includes one additional RGB-sized generation,
  /// tile/native scratch and encoder headroom.
  static int estimatePostDecodeAdditionalBytes({
    required int width,
    required int height,
  }) {
    final int pixels = width * height;
    return pixels * 16 + 384 * 1024 * 1024;
  }

  Future<MemoryAdmissionDecision> waitUntilAdmitted({
    required int requiredAdditionalBytes,
    required bool checkpointAvailable,
    FutureOr<void> Function(MemoryAdmissionDecision decision)? onDecision,
  }) async {
    final Stopwatch wait = Stopwatch()..start();
    MemoryAdmissionDecision decision = await evaluate(
      requiredAdditionalBytes: requiredAdditionalBytes,
      checkpointAvailable: checkpointAvailable,
    );
    if (onDecision != null) await onDecision(decision);

    while (!decision.safeToStart &&
        !decision.shouldRecycleProcessor &&
        wait.elapsed < maximumAdmissionWait) {
      await Future<void>.delayed(pollInterval);
      decision = await evaluate(
        requiredAdditionalBytes: requiredAdditionalBytes,
        checkpointAvailable: checkpointAvailable,
      );
      if (onDecision != null) await onDecision(decision);
    }

    // If pressure has not recovered and a durable checkpoint exists, reclaim
    // the entire Flutter/native heap by recycling only :processor. If no
    // checkpoint exists, return the admission result and let the caller keep
    // waiting/fail explicitly rather than silently lowering image quality.
    if (!decision.safeToStart &&
        !decision.shouldRecycleProcessor &&
        checkpointAvailable &&
        wait.elapsed >= maximumAdmissionWait) {
      return MemoryAdmissionDecision(
        safeToStart: false,
        shouldRecycleProcessor: true,
        requiredAdditionalBytes: requiredAdditionalBytes,
        memoryBudgetBytes: decision.memoryBudgetBytes,
        snapshot: decision.snapshot,
        reason: '${decision.reason}; admission wait exceeded '
            '${maximumAdmissionWait.inSeconds}s, recycle at checkpoint',
      );
    }
    return decision;
  }

  Future<MemoryAdmissionDecision> evaluate({
    required int requiredAdditionalBytes,
    required bool checkpointAvailable,
  }) async {
    final ResourceSnapshot snapshot = await resourceReader();
    final int total = snapshot.totalMemoryBytes ??
        (snapshot.availableMemoryBytes + (snapshot.processRssBytes ?? 0));
    // Keep a large OS/app reserve. The budget is capped at 55% of physical RAM
    // and also leaves at least 768 MiB of currently available memory untouched.
    final int budgetByTotal = (total * 0.55).floor();
    final int memoryBudgetBytes =
        budgetByTotal.clamp(768 * 1024 * 1024, 8 * 1024 * 1024 * 1024).toInt();
    final int rss = snapshot.processRssBytes ?? 0;
    _baselineRssBytes ??= rss > 0 ? rss : null;
    final int? previousRss = _lastRssBytes;
    if (rss > 0 &&
        previousRss != null &&
        rss > previousRss + 16 * 1024 * 1024) {
      _monotonicGrowthSamples++;
    } else if (rss > 0 && previousRss != null && rss <= previousRss) {
      _monotonicGrowthSamples = 0;
    }
    if (rss > 0) _lastRssBytes = rss;

    final int reserve = 768 * 1024 * 1024;
    final bool availableEnough =
        snapshot.availableMemoryBytes >= requiredAdditionalBytes + reserve;
    final bool processBudgetEnough =
        rss <= 0 || rss + requiredAdditionalBytes <= memoryBudgetBytes;
    final bool safe = availableEnough && processBudgetEnough;

    final int baseline = _baselineRssBytes ?? rss;
    final bool strongRssGrowth = rss > 0 &&
        baseline > 0 &&
        rss - baseline >= 512 * 1024 * 1024 &&
        _monotonicGrowthSamples >= 3;
    final bool nearBudget =
        rss > 0 && rss >= (memoryBudgetBytes * 0.82).floor();
    final bool shouldRecycle = checkpointAvailable &&
        (nearBudget || (strongRssGrowth && !availableEnough));

    final String reason = 'memory admission: '
        'need=${requiredAdditionalBytes ~/ (1024 * 1024)}MB, '
        'available=${snapshot.availableMemoryBytes ~/ (1024 * 1024)}MB, '
        'rss=${rss <= 0 ? '?' : rss ~/ (1024 * 1024)}MB, '
        'budget=${memoryBudgetBytes ~/ (1024 * 1024)}MB, '
        'growthSamples=$_monotonicGrowthSamples';
    return MemoryAdmissionDecision(
      safeToStart: safe,
      shouldRecycleProcessor: shouldRecycle,
      requiredAdditionalBytes: requiredAdditionalBytes,
      memoryBudgetBytes: memoryBudgetBytes,
      snapshot: snapshot,
      reason: reason,
    );
  }
}
