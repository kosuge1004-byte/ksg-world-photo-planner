import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle_tile_bounds.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

/// Tests for [cfaDrizzleSourceBounds]. Every expected value below was
/// hand-computed directly from the function's own documented formula
/// (four-corner bounding box under the transform, expanded by
/// `ceil(0.5 * pixfrac)` source pixels, clamped to the source frame's
/// valid extent) before being written here, specifically to avoid the
/// trap of writing a test whose "expected" value is just a restatement
/// of whatever the implementation happens to compute.

final class _Estimate implements SimilarityTransformEstimate {
  const _Estimate({
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
  });

  @override
  final double rotationDegrees;
  @override
  final double sourceOffsetX;
  @override
  final double sourceOffsetY;
  @override
  final double centerX;
  @override
  final double centerY;
}

void main() {
  test(
    'identity変換・outputScale1・pixfrac1: 素朴なタイル範囲をmargin1で'
    '拡張した領域になる',
    () {
      // 手計算: left=top=2, right=bottom=5 (タイル(2,2,4,4)),
      // margin=ceil(0.5*1)=1 -> x=1,y=1, rightInclusive=6,
      // bottomInclusive=6 -> width=height=6。
      final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
        sourceWidth: 20,
        sourceHeight: 20,
        outputTileX: 2,
        outputTileY: 2,
        outputTileWidth: 4,
        outputTileHeight: 4,
        outputScale: 1,
        pixfrac: 1,
      );
      expect(bounds, isNotNull);
      expect(bounds!.x, 1);
      expect(bounds.y, 1);
      expect(bounds.width, 6);
      expect(bounds.height, 6);
    },
  );

  test(
    'マージンはoutputScaleに依存しない(1ピクセルタイルで、境界効果を'
    '排除して検証)',
    () {
      // 1x1タイルなら (outputTileX+width-1)/outputScale ==
      // outputTileX/outputScale となり、境界の丸め方に起因する
      // scale間のズレが発生しない。同じネイティブ中心(10.0,10.0)を
      // 指すタイルを異なるoutputScaleで与え、結果が完全に一致する
      // ことを確認する。
      final CfaDrizzleSourceBounds? boundsScale1 = cfaDrizzleSourceBounds(
        sourceWidth: 50,
        sourceHeight: 50,
        outputTileX: 10,
        outputTileY: 10,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 1,
        pixfrac: 1,
      );
      final CfaDrizzleSourceBounds? boundsScale2 = cfaDrizzleSourceBounds(
        sourceWidth: 50,
        sourceHeight: 50,
        outputTileX: 20, // 10.0 * 2
        outputTileY: 20,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 2,
        pixfrac: 1,
      );
      final CfaDrizzleSourceBounds? boundsScale4 = cfaDrizzleSourceBounds(
        sourceWidth: 50,
        sourceHeight: 50,
        outputTileX: 40, // 10.0 * 4
        outputTileY: 40,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 4,
        pixfrac: 1,
      );
      // 手計算: margin=ceil(0.5*1)=1、中心(10,10) -> x=y=9, width=height=3。
      for (final CfaDrizzleSourceBounds? bounds in <CfaDrizzleSourceBounds?>[
        boundsScale1,
        boundsScale2,
        boundsScale4,
      ]) {
        expect(bounds, isNotNull);
        expect(bounds!.x, 9);
        expect(bounds.y, 9);
        expect(bounds.width, 3);
        expect(bounds.height, 3);
      }
    },
  );

  test('pixfracが大きいほどマージンも大きくなる', () {
    CfaDrizzleSourceBounds? boundsFor(double pixfrac) => cfaDrizzleSourceBounds(
          sourceWidth: 50,
          sourceHeight: 50,
          outputTileX: 25,
          outputTileY: 25,
          outputTileWidth: 1,
          outputTileHeight: 1,
          outputScale: 1,
          pixfrac: pixfrac,
        );
    // pixfrac=0.5 -> margin=ceil(0.25)=1 -> width=25±1=3。
    // pixfrac=3.0 -> margin=ceil(1.5)=2 -> width=25±2=5。
    final CfaDrizzleSourceBounds narrow = boundsFor(0.5)!;
    final CfaDrizzleSourceBounds wide = boundsFor(3.0)!;
    expect(narrow.width, 3);
    expect(wide.width, 5);
    expect(wide.width, greaterThan(narrow.width));
  });

  test('回転を伴う変換は正しく適用される(90度回転で軸が入れ替わる)', () {
    // applySimilarityForwardの式: x' = centerX + cos*ox - sin*oy +
    // sourceOffsetX, y' = centerY + sin*ox + cos*oy + sourceOffsetY
    // (ox=x-centerX, oy=y-centerY)。
    // rotationDegrees=90, center=(0,0), offset=(0,0) のとき
    // cos=0, sin=1 なので x'=-y, y'=x となる。
    // タイル(10,0,1,1) (outputScale=1) はネイティブ座標(10,0)一点のみ:
    // mapCorner(10,0) = (-0, 10) = (0, 10)。
    // margin=ceil(0.5*1)=1 -> x方向: floor(0)-1=-1 -> clamp to 0,
    // rightInclusive=floor(0)+1=1 -> width=1-0+1=2 (左クランプにより
    // 非対称)。y方向: floor(10)-1=9, bottomInclusive=floor(10)+1=11
    // -> height=11-9+1=3。
    const _Estimate rotate90 = _Estimate(
      rotationDegrees: 90,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      centerX: 0,
      centerY: 0,
    );
    final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
      sourceWidth: 50,
      sourceHeight: 50,
      outputTileX: 10,
      outputTileY: 0,
      outputTileWidth: 1,
      outputTileHeight: 1,
      outputScale: 1,
      pixfrac: 1,
      transformEstimate: rotate90,
    );
    expect(bounds, isNotNull);
    expect(bounds!.x, 0);
    expect(bounds.y, 9);
    expect(bounds.width, 2);
    expect(bounds.height, 3);
    // 回転なし(identity)なら同じタイルは x軸周辺(10±1)・y軸周辺(0±1)に
    // マップされるはずで、上記の(0,9)とは明確に異なる -- 回転が実際に
    // 適用されていることの確認。
    final CfaDrizzleSourceBounds? identityBounds = cfaDrizzleSourceBounds(
      sourceWidth: 50,
      sourceHeight: 50,
      outputTileX: 10,
      outputTileY: 0,
      outputTileWidth: 1,
      outputTileHeight: 1,
      outputScale: 1,
      pixfrac: 1,
    );
    expect(identityBounds!.x, isNot(bounds.x));
    expect(identityBounds.y, isNot(bounds.y));
  });

  test('画像範囲外にマップされるタイルはnullを返す', () {
    const _Estimate farAway = _Estimate(
      rotationDegrees: 0,
      sourceOffsetX: 1000,
      sourceOffsetY: 1000,
      centerX: 0,
      centerY: 0,
    );
    final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
      sourceWidth: 20,
      sourceHeight: 20,
      outputTileX: 5,
      outputTileY: 5,
      outputTileWidth: 2,
      outputTileHeight: 2,
      outputScale: 1,
      pixfrac: 1,
      transformEstimate: farAway,
    );
    expect(bounds, isNull);
  });

  test('ソース画像の端に近いタイルは有効範囲内へクランプされる', () {
    final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
      sourceWidth: 10,
      sourceHeight: 10,
      outputTileX: 0,
      outputTileY: 0,
      outputTileWidth: 2,
      outputTileHeight: 2,
      outputScale: 1,
      pixfrac: 1,
    );
    // 手計算: left=top=0, right=bottom=1, margin=1 -> x=floor(0)-1=-1
    // -> clamp to 0, rightInclusive=floor(1)+1=2 -> width=2-0+1=3。
    expect(bounds, isNotNull);
    expect(bounds!.x, 0);
    expect(bounds.y, 0);
    expect(bounds.width, 3);
    expect(bounds.height, 3);
  });

  test('非正のパラメータはArgumentErrorを投げる', () {
    expect(
      () => cfaDrizzleSourceBounds(
        sourceWidth: 0,
        sourceHeight: 10,
        outputTileX: 0,
        outputTileY: 0,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 1,
        pixfrac: 1,
      ),
      throwsA(isA<ArgumentError>()),
    );
    expect(
      () => cfaDrizzleSourceBounds(
        sourceWidth: 10,
        sourceHeight: 10,
        outputTileX: 0,
        outputTileY: 0,
        outputTileWidth: 0,
        outputTileHeight: 1,
        outputScale: 1,
        pixfrac: 1,
      ),
      throwsA(isA<ArgumentError>()),
    );
    expect(
      () => cfaDrizzleSourceBounds(
        sourceWidth: 10,
        sourceHeight: 10,
        outputTileX: 0,
        outputTileY: 0,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 0,
        pixfrac: 1,
      ),
      throwsA(isA<ArgumentError>()),
    );
    expect(
      () => cfaDrizzleSourceBounds(
        sourceWidth: 10,
        sourceHeight: 10,
        outputTileX: 0,
        outputTileY: 0,
        outputTileWidth: 1,
        outputTileHeight: 1,
        outputScale: 1,
        pixfrac: -1,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
    'additionalMarginが既存のmargin計算へ正しく加算される'
    '(Work123: 局所補正の最大変位を追加マージンとして考慮する機能の'
    '検証、手計算)',
    () {
      // identity変換, outputScale=1, pixfrac=1, タイル(2,2,4,4)は
      // 上記の最初のテストと同じ設定。additionalMargin=2.3を追加。
      // marginPixels = ceil(0.5*1 + 2.3) = ceil(2.8) = 3。
      // 手計算: left=top=2, right=bottom=5, margin=3
      // -> x=2-3=-1、0にクランプ、y=0(同様)
      // -> rightInclusive=5+3=8, bottomInclusive=8
      // -> width=8-0+1=9, height=9。
      final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
        sourceWidth: 20,
        sourceHeight: 20,
        outputTileX: 2,
        outputTileY: 2,
        outputTileWidth: 4,
        outputTileHeight: 4,
        outputScale: 1,
        pixfrac: 1,
        additionalMargin: 2.3,
      );
      expect(bounds, isNotNull);
      expect(bounds!.x, 0);
      expect(bounds.y, 0);
      expect(bounds.width, 9);
      expect(bounds.height, 9);
    },
  );

  test('additionalMarginが負の場合はArgumentErrorを投げる', () {
    expect(
      () => cfaDrizzleSourceBounds(
        sourceWidth: 20,
        sourceHeight: 20,
        outputTileX: 0,
        outputTileY: 0,
        outputTileWidth: 4,
        outputTileHeight: 4,
        outputScale: 1,
        pixfrac: 1,
        additionalMargin: -0.1,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });
}
