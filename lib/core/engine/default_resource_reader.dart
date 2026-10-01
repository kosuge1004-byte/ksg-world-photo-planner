import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import 'resource_snapshot.dart';

// These are the values used when the platform channel / /proc reads are
// unavailable and the real snapshot cannot be constructed. Previously 2 GiB
// / 0.0 / 1.0 (the fully-healthy corner in every ConcurrencyPolicy
// threshold), which the comments called "conservative" while the actual
// effect was "assume the device is in the best possible state" — the
// opposite of what a conservative fallback should do, and worst exactly
// when telemetry is least trustworthy. These instead land just inside each
// threshold's first restricted tier (see concurrency_policy.dart), enough to
// meaningfully cap concurrency without collapsing to the most extreme tier
// on every transient read glitch.
const int _fallbackAvailableMemoryBytes = 850 * 1024 * 1024;
const double _fallbackThermalPressure = 0.5;
const double _fallbackBatteryLevel = 0.12;

const MethodChannel _deviceResourcesChannel = MethodChannel(
  'com.mobilestack.app/device_resources',
);

int? _previousSystemCpuTotal;
int? _previousSystemCpuIdle;
int? _previousProcessCpuTicks;

int? _parseKbValue(String text, String key) {
  final RegExpMatch? match =
      RegExp('^$key:\\s+(\\d+)\\s+kB\\s*\$', multiLine: true).firstMatch(text);
  final int? kb = int.tryParse(match?.group(1) ?? '');
  return kb == null ? null : kb * 1024;
}

Future<Map<String, num>> _readAndroidProcSnapshot() async {
  final Map<String, num> values = <String, num>{};
  int? systemDeltaTotal;
  try {
    final String memInfo = await File('/proc/meminfo').readAsString();
    final int? available = _parseKbValue(memInfo, 'MemAvailable');
    final int? total = _parseKbValue(memInfo, 'MemTotal');
    if (available != null && available > 0) {
      values['availableMemoryBytes'] = available;
    }
    if (total != null && total > 0) values['totalMemoryBytes'] = total;
  } on Object {
    // Best-effort only. The platform-channel/fallback path remains available.
  }

  try {
    final String status = await File('/proc/self/status').readAsString();
    final int? rss = _parseKbValue(status, 'VmRSS');
    if (rss != null && rss >= 0) values['processRssBytes'] = rss;
  } on Object {
    // Best-effort only.
  }

  try {
    final String stat = await File('/proc/stat').readAsLines().then(
          (List<String> lines) =>
              lines.firstWhere((String line) => line.startsWith('cpu ')),
        );
    final List<int> ticks = stat
        .trim()
        .split(RegExp(r'\s+'))
        .skip(1)
        .map((String value) => int.tryParse(value) ?? 0)
        .toList(growable: false);
    if (ticks.length >= 4) {
      final int total = ticks.fold<int>(0, (int sum, int value) => sum + value);
      final int idle = ticks[3] + (ticks.length > 4 ? ticks[4] : 0);
      final int? previousTotal = _previousSystemCpuTotal;
      final int? previousIdle = _previousSystemCpuIdle;
      if (previousTotal != null &&
          previousIdle != null &&
          total > previousTotal) {
        final int deltaTotal = total - previousTotal;
        final int deltaIdle = idle - previousIdle;
        systemDeltaTotal = deltaTotal;
        values['systemCpuLoad'] =
            ((deltaTotal - deltaIdle) / deltaTotal).clamp(0.0, 1.0);
      }
      _previousSystemCpuTotal = total;
      _previousSystemCpuIdle = idle;
    }
  } on Object {
    // Best-effort only.
  }

  try {
    final String raw = await File('/proc/self/stat').readAsString();
    final int closeParen = raw.lastIndexOf(')');
    if (closeParen >= 0 && closeParen + 2 < raw.length) {
      // Fields after comm start at Linux /proc pid stat field 3 (state).
      final List<String> fields =
          raw.substring(closeParen + 2).trim().split(RegExp(r'\s+'));
      if (fields.length > 12) {
        final int utime = int.tryParse(fields[11]) ?? 0; // field 14
        final int stime = int.tryParse(fields[12]) ?? 0; // field 15
        final int processTicks = utime + stime;
        final int? previousProcess = _previousProcessCpuTicks;
        final int? deltaTotal = systemDeltaTotal;
        if (previousProcess != null && deltaTotal != null && deltaTotal > 0) {
          final int deltaProcess = processTicks - previousProcess;
          if (deltaProcess >= 0) {
            values['processCpuLoad'] =
                (deltaProcess / deltaTotal).clamp(0.0, 1.0);
          }
        }
        _previousProcessCpuTicks = processTicks;
      }
    }
  } on Object {
    // Best-effort only.
  }

  try {
    final String capacity =
        (await File('/sys/class/power_supply/battery/capacity').readAsString())
            .trim();
    final int? percent = int.tryParse(capacity);
    if (percent != null && percent >= 0 && percent <= 100) {
      values['batteryLevel'] = percent / 100.0;
    }
  } on Object {
    // Some Android builds restrict sysfs access.
  }

  try {
    final String rawTemp =
        (await File('/sys/class/power_supply/battery/temp').readAsString())
            .trim();
    final int? deciC = int.tryParse(rawTemp);
    if (deciC != null) {
      final double celsius = deciC / 10.0;
      if (celsius >= -20 && celsius <= 100) {
        values['batteryTemperatureC'] = celsius;
      }
    }
  } on Object {
    // Best-effort only.
  }

  return values;
}

/// Reads resource headroom in a way that also works inside WorkManager's
/// headless Flutter engine.
///
/// Work310/311 relied primarily on a MethodChannel installed by MainActivity.
/// That channel belongs to the foreground Activity engine and is not a
/// dependable source for a headless WorkManager engine. Android therefore
/// gets memory/RSS/CPU/battery readings directly from /proc and readable sysfs
/// first, then supplements them with the Activity channel when it exists.
Future<ResourceSnapshot> readDefaultResourceSnapshot() async {
  int availableMemoryBytes = _fallbackAvailableMemoryBytes;
  int? totalMemoryBytes;
  int? processRssBytes;
  double thermalPressure = _fallbackThermalPressure;
  double batteryLevel = _fallbackBatteryLevel;
  double? systemCpuLoad;
  double? processCpuLoad;
  double? batteryTemperatureC;
  int? availableStorageBytes;

  if (Platform.isAndroid) {
    final Map<String, num> proc = await _readAndroidProcSnapshot();
    availableMemoryBytes =
        proc['availableMemoryBytes']?.toInt() ?? availableMemoryBytes;
    totalMemoryBytes = proc['totalMemoryBytes']?.toInt();
    processRssBytes = proc['processRssBytes']?.toInt();
    systemCpuLoad = proc['systemCpuLoad']?.toDouble();
    processCpuLoad = proc['processCpuLoad']?.toDouble();
    batteryLevel = proc['batteryLevel']?.toDouble() ?? batteryLevel;
    batteryTemperatureC = proc['batteryTemperatureC']?.toDouble();

    try {
      final Object? raw = await _deviceResourcesChannel.invokeMethod<Object?>(
        'readResourceSnapshot',
      );
      if (raw is Map) {
        final Object? mem = raw['availableMemoryBytes'];
        final Object? total = raw['totalMemoryBytes'];
        final Object? rss = raw['processRssBytes'];
        final Object? thermal = raw['thermalPressure'];
        final Object? battery = raw['batteryLevel'];
        final Object? temperature = raw['batteryTemperatureC'];
        final Object? storage = raw['availableStorageBytes'];
        if (mem is num && mem > 0) availableMemoryBytes = mem.toInt();
        if (total is num && total > 0) totalMemoryBytes = total.toInt();
        if (rss is num && rss >= 0) processRssBytes = rss.toInt();
        if (thermal is num) thermalPressure = thermal.toDouble().clamp(0, 1);
        if (battery is num) batteryLevel = battery.toDouble().clamp(0, 1);
        if (temperature is num && temperature.toDouble().isFinite) {
          batteryTemperatureC = temperature.toDouble();
        }
        if (storage is num && storage >= 0) {
          availableStorageBytes = storage.toInt();
        }
      }
    } on PlatformException {
      // Expected in some headless/test environments. /proc readings above remain.
    } on MissingPluginException {
      // Expected for a WorkManager headless engine when MainActivity is absent.
    }
  }

  return ResourceSnapshot(
    logicalProcessors: Platform.numberOfProcessors,
    availableMemoryBytes: availableMemoryBytes,
    totalMemoryBytes: totalMemoryBytes,
    processRssBytes: processRssBytes,
    thermalPressure: thermalPressure,
    batteryLevel: batteryLevel,
    systemCpuLoad: systemCpuLoad,
    processCpuLoad: processCpuLoad,
    batteryTemperatureC: batteryTemperatureC,
    availableStorageBytes: availableStorageBytes,
  );
}
