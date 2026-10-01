import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/tiles/tile_grid.dart';

void main() {
  test('画像端のタイル寸法を切り詰める', () {
    final tiles = const TileGrid(
      preferredTileWidth: 1000,
      preferredTileHeight: 1000,
    ).create(imageWidth: 2500, imageHeight: 1800);

    expect(tiles.length, 6);
    expect(tiles.last.width, 500);
    expect(tiles.last.height, 800);
  });
}
