import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/concurrency_policy.dart';
import 'package:mobile_stack/core/engine/resource_snapshot.dart';

void main() {
  const ConcurrencyPolicy policy = ConcurrencyPolicy();

  test('never exceeds twelve workers', () {
    const ResourceSnapshot snapshot = ResourceSnapshot(
      logicalProcessors: 32,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      thermalPressure: 0,
      batteryLevel: 1,
    );
    expect(policy.resolveWorkerCount(snapshot), 12);
  });

  test('reduces workers during thermal pressure', () {
    const ResourceSnapshot snapshot = ResourceSnapshot(
      logicalProcessors: 12,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      thermalPressure: 0.9,
      batteryLevel: 1,
    );
    expect(policy.resolveWorkerCount(snapshot), 2);
  });

  test('full-frame RAW processing always uses one worker', () {
    const ResourceSnapshot snapshot = ResourceSnapshot(
      logicalProcessors: 32,
      availableMemoryBytes: 16 * 1024 * 1024 * 1024,
      thermalPressure: 0,
      batteryLevel: 1,
    );
    expect(fullFrameRawConcurrencyPolicy.resolveWorkerCount(snapshot), 1);
  });
}
