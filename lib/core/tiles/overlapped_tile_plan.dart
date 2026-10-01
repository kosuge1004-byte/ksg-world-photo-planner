class OverlappedTile {
  const OverlappedTile({
    required this.outputX,
    required this.outputY,
    required this.outputWidth,
    required this.outputHeight,
    required this.inputX,
    required this.inputY,
    required this.inputWidth,
    required this.inputHeight,
  });

  final int outputX;
  final int outputY;
  final int outputWidth;
  final int outputHeight;
  final int inputX;
  final int inputY;
  final int inputWidth;
  final int inputHeight;
}

class OverlappedTilePlan {
  const OverlappedTilePlan({required this.tiles});
  final List<OverlappedTile> tiles;

  factory OverlappedTilePlan.create({
    required int imageWidth,
    required int imageHeight,
    required int tileSize,
    required int overlap,
  }) {
    if (imageWidth <= 0 || imageHeight <= 0 || tileSize <= 0 || overlap < 0) {
      throw ArgumentError('Invalid tile-plan dimensions.');
    }
    if (overlap * 2 >= tileSize) {
      throw ArgumentError('Overlap must be smaller than half the tile size.');
    }

    final List<OverlappedTile> tiles = <OverlappedTile>[];
    for (int y = 0; y < imageHeight; y += tileSize) {
      for (int x = 0; x < imageWidth; x += tileSize) {
        final int outputWidth = (imageWidth - x).clamp(0, tileSize);
        final int outputHeight = (imageHeight - y).clamp(0, tileSize);
        final int inputX = (x - overlap).clamp(0, imageWidth);
        final int inputY = (y - overlap).clamp(0, imageHeight);
        final int inputRight = (x + outputWidth + overlap).clamp(0, imageWidth);
        final int inputBottom =
            (y + outputHeight + overlap).clamp(0, imageHeight);
        tiles.add(OverlappedTile(
          outputX: x,
          outputY: y,
          outputWidth: outputWidth,
          outputHeight: outputHeight,
          inputX: inputX,
          inputY: inputY,
          inputWidth: inputRight - inputX,
          inputHeight: inputBottom - inputY,
        ));
      }
    }
    return OverlappedTilePlan(tiles: List<OverlappedTile>.unmodifiable(tiles));
  }
}
