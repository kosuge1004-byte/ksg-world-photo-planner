class ImageTile {
  const ImageTile({
    required this.index,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final int index;
  final int x;
  final int y;
  final int width;
  final int height;
}

class TileGrid {
  const TileGrid({
    this.preferredTileWidth = 1024,
    this.preferredTileHeight = 1024,
  })  : assert(preferredTileWidth > 0),
        assert(preferredTileHeight > 0);

  final int preferredTileWidth;
  final int preferredTileHeight;

  List<ImageTile> create({required int imageWidth, required int imageHeight}) {
    if (imageWidth <= 0 || imageHeight <= 0) return const <ImageTile>[];
    final List<ImageTile> tiles = <ImageTile>[];
    int index = 0;
    for (int y = 0; y < imageHeight; y += preferredTileHeight) {
      for (int x = 0; x < imageWidth; x += preferredTileWidth) {
        tiles.add(
          ImageTile(
            index: index++,
            x: x,
            y: y,
            width: (imageWidth - x).clamp(1, preferredTileWidth),
            height: (imageHeight - y).clamp(1, preferredTileHeight),
          ),
        );
      }
    }
    return List<ImageTile>.unmodifiable(tiles);
  }
}
