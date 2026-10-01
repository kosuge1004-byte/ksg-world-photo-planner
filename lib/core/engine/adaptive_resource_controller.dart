import 'dart:async';

import 'resource_snapshot.dart';

enum AdaptiveResourceState {
  boost,
  normal,
  constrained,
  critical,
}

final class AdaptiveResourceDecision {
  const AdaptiveResourceDecision({
    required this.state,
    required this.delayBeforeNextFrame,
    required this.snapshot,
    required this.reason,
  });

  final AdaptiveResourceState state;
  final Duration delayBeforeNextFrame;
  final ResourceSnapshot snapshot;
  final String reason;

  bool get shouldPauseForRecovery => state == AdaptiveResourceState.critical;
}

/// Adaptive, quality-neutral backpressure for long RAW stacks.
///
/// This controller never changes demosaic math, output precision, image size,
/// stacking weights, or export settings. It only controls the gap between
/// completed full-frame jobs. Healthy devices therefore run with zero fixed
/// cooldown, while genuinely constrained devices receive progressively more
/// breathing room. Critical memory/thermal pressure temporarily gates the next
/// frame and automatically resumes after headroom returns.
///
/// ## Trend detection
/// [_classify] originally only compared the *current* snapshot against
/// fixed thresholds — a job that is 40MB from the critical floor but
/// losing 30MB every frame looked identical to one holding steady at the
/// same level, right up until the frame that actually crosses the line.
/// [sample] now also keeps a short rolling history of
/// `processRssBytes`/`availableMemoryBytes` and escalates one state early
/// when the *trend* projects hitting the critical floor within
/// [_trendLookaheadFrames], even while the current snapshot is still
/// merely `constrained`. This buys the same number of actual throttled
/// frames either way — it just starts them a little sooner, which is the
/// entire difference between "slowed down in time" and "hit the wall".
final class AdaptiveResourceController {
  AdaptiveResourceController({
    required this.resourceReader,
    this.criticalPollInterval = const Duration(seconds: 1),
    this.maximumCriticalPause = const Duration(minutes: 2),
  });

  final Future<ResourceSnapshot> Function() resourceReader;
  final Duration criticalPollInterval;
  final Duration maximumCriticalPause;

  static const int _trendWindow = 5;
  static const int _trendLookaheadFrames = 3;

  AdaptiveResourceState _state = AdaptiveResourceState.normal;
  int _healthySamples = 0;
  final List<int> _recentAvailableMemoryBytes = <int>[];

  AdaptiveResourceState get state => _state;

  Future<AdaptiveResourceDecision> sample() async {
    final ResourceSnapshot snapshot = await resourceReader();
    AdaptiveResourceState raw = _classify(snapshot);
    String? trendReason;

    _recentAvailableMemoryBytes.add(snapshot.availableMemoryBytes);
    if (_recentAvailableMemoryBytes.length > _trendWindow) {
      _recentAvailableMemoryBytes.removeAt(0);
    }
    if (raw != AdaptiveResourceState.critical &&
        _recentAvailableMemoryBytes.length >= 3) {
      final int perSampleDrop = _averagePerSampleDrop(
        _recentAvailableMemoryBytes,
      );
      if (perSampleDrop > 0) {
        final int projected = snapshot.availableMemoryBytes -
            perSampleDrop * _trendLookaheadFrames;
        if (projected < 384 * 1024 * 1024) {
          // Projected to reach the critical floor within a handful of
          // frames at the current burn rate: escalate one state early so
          // the slowdown/pause actually has time to change the outcome,
          // rather than only reacting once already there.
          raw = AdaptiveResourceState.values[(raw.index + 1)
              .clamp(0, AdaptiveResourceState.values.length - 1)];
          trendReason =
              'trending toward critical: -${perSampleDrop ~/ (1024 * 1024)}MB/sample';
        }
      }
    }

    // Hysteresis: escalation is immediate, but recovery requires two healthy
    // frame-boundary samples. This prevents rapid boost/constrained flapping
    // around one threshold without keeping a recovered device artificially
    // slow for long.
    if (raw.index > _state.index) {
      _state = raw;
      _healthySamples = 0;
    } else if (raw.index < _state.index) {
      _healthySamples++;
      if (_healthySamples >= 2) {
        _state = raw;
        _healthySamples = 0;
      }
    } else {
      _healthySamples = 0;
    }

    return AdaptiveResourceDecision(
      state: _state,
      delayBeforeNextFrame: _delayFor(_state),
      snapshot: snapshot,
      reason: trendReason ?? _reason(snapshot, _state),
    );
  }

  /// Average decrease in `availableMemoryBytes` between consecutive
  /// samples in [samples] (oldest first). Zero or negative (i.e. memory
  /// recovering or flat) is reported as `0` — this trend check only ever
  /// escalates for a genuinely worsening trend, never for a healthy one.
  static int _averagePerSampleDrop(List<int> samples) {
    int totalDrop = 0;
    int comparisons = 0;
    for (int i = 1; i < samples.length; i++) {
      final int delta = samples[i - 1] - samples[i];
      if (delta > 0) totalDrop += delta;
      comparisons++;
    }
    if (comparisons == 0) return 0;
    return totalDrop ~/ comparisons;
  }

  Future<AdaptiveResourceDecision> waitUntilSafeToStartNextFrame({
    FutureOr<void> Function(AdaptiveResourceDecision decision)? onDecision,
  }) async {
    AdaptiveResourceDecision decision = await sample();
    if (onDecision != null) await onDecision(decision);

    if (!decision.shouldPauseForRecovery) {
      final Duration delay = decision.delayBeforeNextFrame;
      if (delay > Duration.zero) await Future<void>.delayed(delay);
      return decision;
    }

    final Stopwatch pause = Stopwatch()..start();
    while (decision.shouldPauseForRecovery &&
        pause.elapsed < maximumCriticalPause) {
      await Future<void>.delayed(criticalPollInterval);
      decision = await sample();
      if (onDecision != null) await onDecision(decision);
    }

    // If Android remains critically constrained for an extended period, do
    // not deadlock the job indefinitely. Keep the conservative four-second
    // legacy ceiling before attempting one next frame; the Work311 durable
    // checkpoint means a process kill cannot erase all prior completed work.
    final Duration delay = decision.shouldPauseForRecovery
        ? const Duration(seconds: 4)
        : decision.delayBeforeNextFrame;
    if (delay > Duration.zero) await Future<void>.delayed(delay);
    return decision;
  }

  AdaptiveResourceState _classify(ResourceSnapshot snapshot) {
    final int available = snapshot.availableMemoryBytes;
    final double? availableFraction = snapshot.availableMemoryFraction;
    final double effectiveThermal = _effectiveThermalPressure(snapshot);

    if (available < 384 * 1024 * 1024 ||
        (availableFraction != null && availableFraction < 0.06) ||
        effectiveThermal >= 0.90) {
      return AdaptiveResourceState.critical;
    }

    if (available < 896 * 1024 * 1024 ||
        (availableFraction != null && availableFraction < 0.14) ||
        effectiveThermal >= 0.68) {
      return AdaptiveResourceState.constrained;
    }

    if (available >= 2304 * 1024 * 1024 &&
        (availableFraction == null || availableFraction >= 0.28) &&
        effectiveThermal < 0.40) {
      return AdaptiveResourceState.boost;
    }

    return AdaptiveResourceState.normal;
  }

  Duration _delayFor(AdaptiveResourceState state) {
    switch (state) {
      case AdaptiveResourceState.boost:
      case AdaptiveResourceState.normal:
        return Duration.zero;
      case AdaptiveResourceState.constrained:
        return const Duration(seconds: 2);
      case AdaptiveResourceState.critical:
        return criticalPollInterval;
    }
  }

  double _effectiveThermalPressure(ResourceSnapshot snapshot) {
    double pressure = snapshot.thermalPressure.clamp(0.0, 1.0);
    final double? batteryC = snapshot.batteryTemperatureC;
    if (batteryC != null) {
      // Battery temperature is only a fallback proxy when Android's thermal
      // API is unavailable in a headless engine. 40 C is not throttling;
      // pressure ramps conservatively from 42 C and reaches critical at 48 C.
      final double proxy =
          batteryC <= 42 ? 0.0 : ((batteryC - 42) / 6).clamp(0.0, 1.0);
      if (proxy > pressure) pressure = proxy;
    }
    return pressure;
  }

  String _reason(ResourceSnapshot snapshot, AdaptiveResourceState state) {
    final int availableMb = snapshot.availableMemoryBytes ~/ (1024 * 1024);
    final int? total = snapshot.totalMemoryBytes;
    final String memoryText = total == null
        ? '${availableMb}MB free'
        : '${availableMb}MB free/${total ~/ (1024 * 1024)}MB';
    final int? rss = snapshot.processRssBytes;
    final String rssText =
        rss == null ? 'rss=?' : 'rss=${rss ~/ (1024 * 1024)}MB';
    final String cpuText = snapshot.systemCpuLoad == null
        ? 'cpu=?'
        : 'cpu=${(snapshot.systemCpuLoad! * 100).round()}%';
    final String thermalText = snapshot.batteryTemperatureC == null
        ? 'thermal=${snapshot.thermalPressure.toStringAsFixed(2)}'
        : 'battery=${snapshot.batteryTemperatureC!.toStringAsFixed(1)}C';
    return '${state.name}: $memoryText, $rssText, $cpuText, $thermalText';
  }
}
