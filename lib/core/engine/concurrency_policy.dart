import 'resource_snapshot.dart';

class ConcurrencyPolicy {
  const ConcurrencyPolicy({this.maximumWorkers = 12})
      : assert(maximumWorkers > 0);

  final int maximumWorkers;

  int resolveWorkerCount(ResourceSnapshot snapshot) {
    final int cpuLimit = snapshot.logicalProcessors.clamp(1, maximumWorkers);

    int thermalLimit = maximumWorkers;
    if (snapshot.thermalPressure >= 0.85) {
      thermalLimit = 2;
    } else if (snapshot.thermalPressure >= 0.65) {
      thermalLimit = 4;
    } else if (snapshot.thermalPressure >= 0.45) {
      thermalLimit = 8;
    }

    int memoryLimit = maximumWorkers;
    if (snapshot.availableMemoryBytes < 512 * 1024 * 1024) {
      memoryLimit = 2;
    } else if (snapshot.availableMemoryBytes < 1024 * 1024 * 1024) {
      memoryLimit = 4;
    } else if (snapshot.availableMemoryBytes < 2 * 1024 * 1024 * 1024) {
      memoryLimit = 8;
    }

    final int batteryLimit = snapshot.batteryLevel < 0.15 ? 4 : maximumWorkers;

    return <int>[cpuLimit, thermalLimit, memoryLimit, batteryLimit]
        .reduce((int a, int b) => a < b ? a : b)
        .clamp(1, maximumWorkers);
  }
}

/// Full-frame RAW jobs retain a large FP32 CFA buffer through the quality
/// pipeline. Keeping the entire job in one lane prevents adjacent files from
/// multiplying that peak allocation.
const ConcurrencyPolicy fullFrameRawConcurrencyPolicy =
    ConcurrencyPolicy(maximumWorkers: 1);
