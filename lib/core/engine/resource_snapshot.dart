class ResourceSnapshot {
  const ResourceSnapshot({
    required this.logicalProcessors,
    required this.availableMemoryBytes,
    required this.thermalPressure,
    required this.batteryLevel,
    this.totalMemoryBytes,
    this.processRssBytes,
    this.systemCpuLoad,
    this.processCpuLoad,
    this.batteryTemperatureC,
    this.availableStorageBytes,
  });

  final int logicalProcessors;
  final int availableMemoryBytes;
  final int? totalMemoryBytes;
  final int? processRssBytes;
  final double thermalPressure;
  final double batteryLevel;
  final double? systemCpuLoad;
  final double? processCpuLoad;
  final double? batteryTemperatureC;
  final int? availableStorageBytes;

  double? get availableMemoryFraction {
    final int? total = totalMemoryBytes;
    if (total == null || total <= 0) return null;
    return (availableMemoryBytes / total).clamp(0.0, 1.0);
  }

  double? get processMemoryFraction {
    final int? total = totalMemoryBytes;
    final int? rss = processRssBytes;
    if (total == null || total <= 0 || rss == null || rss < 0) return null;
    return (rss / total).clamp(0.0, 1.0);
  }
}
