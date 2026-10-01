import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test('creates overlap only inside image bounds', () {
    final plan = OverlappedTilePlan.create(
      imageWidth: 1000,
      imageHeight: 700,
      tileSize: 512,
      overlap: 24,
    );

    expect(plan.tiles, hasLength(4));
    final first = plan.tiles.first;
    expect(first.inputX, 0);
    expect(first.inputY, 0);
    expect(first.inputWidth, 536);
    expect(first.inputHeight, 536);

    final last = plan.tiles.last;
    expect(last.outputWidth, 488);
    expect(last.outputHeight, 188);
    expect(last.inputX + last.inputWidth, 1000);
    expect(last.inputY + last.inputHeight, 700);
  });
}
