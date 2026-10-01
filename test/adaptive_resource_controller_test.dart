import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/adaptive_resource_controller.dart';
import 'package:mobile_stack/core/engine/resource_snapshot.dart';

ResourceSnapshot snapshot({
  int availableMb = 4096,
  int totalMb = 8192,
  double thermal = 0,
  double? batteryC = 35,
}) =>
    ResourceSnapshot(
      logicalProcessors: 8,
      availableMemoryBytes: availableMb * 1024 * 1024,
      totalMemoryBytes: totalMb * 1024 * 1024,
      processRssBytes: 512 * 1024 * 1024,
      thermalPressure: thermal,
      batteryLevel: 0.8,
      batteryTemperatureC: batteryC,
    );

void main() {
  test('healthy device removes the old fixed cooldown', () async {
    final AdaptiveResourceController controller = AdaptiveResourceController(
      resourceReader: () async => snapshot(),
    );
    final AdaptiveResourceDecision first = await controller.sample();
    final AdaptiveResourceDecision second = await controller.sample();
    expect(second.state, AdaptiveResourceState.boost);
    expect(second.delayBeforeNextFrame, Duration.zero);
    expect(first.delayBeforeNextFrame, Duration.zero);
  });

  test('low memory escalates immediately to constrained', () async {
    final AdaptiveResourceController controller = AdaptiveResourceController(
      resourceReader: () async => snapshot(availableMb: 700),
    );
    final AdaptiveResourceDecision decision = await controller.sample();
    expect(decision.state, AdaptiveResourceState.constrained);
    expect(decision.delayBeforeNextFrame, const Duration(seconds: 2));
  });

  test('critical memory gates the next frame', () async {
    final AdaptiveResourceController controller = AdaptiveResourceController(
      resourceReader: () async => snapshot(availableMb: 300),
      maximumCriticalPause: Duration.zero,
    );
    final AdaptiveResourceDecision decision = await controller.sample();
    expect(decision.state, AdaptiveResourceState.critical);
    expect(decision.shouldPauseForRecovery, isTrue);
  });

  test('battery temperature can provide headless thermal fallback', () async {
    final AdaptiveResourceController controller = AdaptiveResourceController(
      resourceReader: () async => snapshot(batteryC: 47.5),
    );
    final AdaptiveResourceDecision decision = await controller.sample();
    expect(decision.state, AdaptiveResourceState.critical);
  });
}
