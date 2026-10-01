import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image/image.dart' as img;

import '../../core/demosaic/demosaic_registry.dart';
import '../../core/demosaic/native_mobile_stack_demosaic_engine.dart';
import '../../core/engine/phase2_validated_job_executor.dart';
import '../../core/engine/processing_job.dart';
import '../../core/focus_stack/focus_exact_preview.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/registration/luminance_plane.dart';
import '../../core/session/processing_session.dart';
import '../../core/stacking/foreground_region.dart';

final class _PreviewRequest {
  const _PreviewRequest(this.path, this.token);
  final String path;
  final RootIsolateToken? token;
}

final class _Preview {
  const _Preview(this.png, this.width, this.height);
  final Uint8List png;
  final int width, height;
}

Future<_Preview> _decodeReferencePreview(_PreviewRequest request) async {
  if (request.token != null) {
    BackgroundIsolateBinaryMessenger.ensureInitialized(request.token!);
  }
  _Preview? preview;
  await runPhase2ValidatedJob(
    ProcessingJob(
        id: 'foreground-preview',
        mode: ProcessingMode.starTrail,
        sourcePath: request.path),
    (_) {},
    decoderRegistry: createProductionBackgroundNativeRawDecoderRegistry(),
    metadataProbe: createProductionNativeRawMetadataProbe(),
    demosaicRegistry: DemosaicRegistry([NativeMobileStackDemosaicEngine()]),
    fileBackRawBeforeDemosaic: true,
    preferStreamedRawCalibration: true,
    onTileStoreReady: (store) async {
      try {
        final step =
            math.max(1, (math.max(store.width, store.height) / 1024).ceil());
        final w = (store.width + step - 1) ~/ step,
            h = (store.height + step - 1) ~/ step;
        final green = Float32List(w * h);
        for (int y = 0; y < h; y++) {
          final row = await store.readRegion(
              x: 0, y: y * step, width: store.width, height: 1);
          for (int x = 0; x < w; x++) {
            green[y * w + x] = row.interleavedRgb[x * step * 3 + 1];
          }
        }
        final exact = buildExactFocusPreview(
            LuminancePlane(width: w, height: h, samples: green));
        final image = img.Image(width: exact.width, height: exact.height);
        for (int y = 0; y < exact.height; y++) {
          for (int x = 0; x < exact.width; x++) {
            final v = exact.luminance8[y * exact.width + x];
            image.setPixelRgb(x, y, v, v, v);
          }
        }
        preview = _Preview(Uint8List.fromList(img.encodePng(image)),
            store.width, store.height);
      } finally {
        await store.dispose();
      }
    },
  );
  if (preview == null) throw StateError('基準RAWのプレビューを作成できませんでした。');
  return preview!;
}

/// Display-only preview from the actual decoded reference grid. Embedded JPEG
/// orientation/crop is deliberately not used for a processing mask.
class ForegroundRegionScreen extends StatefulWidget {
  const ForegroundRegionScreen({super.key, required this.session});
  final ProcessingSession session;
  @override
  State<ForegroundRegionScreen> createState() => _ForegroundRegionScreenState();
}

class _ForegroundRegionScreenState extends State<ForegroundRegionScreen> {
  late final Future<_Preview> preview;
  final polygons = <List<({double x, double y})>>[];
  final active = <({double x, double y})>[];
  @override
  void initState() {
    super.initState();
    polygons.addAll(widget.session.foregroundRegion?.polygons ?? []);
    final path = widget.session.referencePath;
    preview = path == null
        ? Future.error(StateError('先に基準写真を選んでください。'))
        : compute(_decodeReferencePreview,
            _PreviewRequest(path, RootIsolateToken.instance));
  }

  void finishPolygon() {
    if (active.length < 3) return;
    try {
      ForegroundRegion([...polygons, active]);
      setState(() {
        polygons.add(List.of(active));
        active.clear();
      });
    } on ArgumentError catch (error) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('地上光を抑える領域')),
        body: FutureBuilder<_Preview>(
            future: preview,
            builder: (context, snapshot) {
              if (snapshot.hasError) {
                return Center(
                    child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text('${snapshot.error}')));
              }
              if (!snapshot.hasData) {
                return const Center(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 16),
                  Text('基準RAWからプレビューを作成しています'),
                ]));
              }
              final image = snapshot.data!;
              return Column(children: [
                const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text(
                        '地上部分を点で囲み、「領域を追加」を押してください。空は囲まないでください。拡大して複数の領域を指定できます。')),
                Expanded(
                    child: InteractiveViewer(
                        minScale: 1,
                        maxScale: 12,
                        child: Center(
                          child: AspectRatio(
                              aspectRatio: image.width / image.height,
                              child: LayoutBuilder(
                                builder: (context, constraints) =>
                                    GestureDetector(
                                        onTapDown: (details) => setState(() {
                                              if (active.length >= 512) return;
                                              active.add((
                                                x: (details.localPosition.dx /
                                                        constraints.maxWidth)
                                                    .clamp(0.0, 1.0),
                                                y: (details.localPosition.dy /
                                                        constraints.maxHeight)
                                                    .clamp(0.0, 1.0)
                                              ));
                                            }),
                                        child: Stack(
                                            fit: StackFit.expand,
                                            children: [
                                              Image.memory(image.png,
                                                  fit: BoxFit.fill),
                                              CustomPaint(
                                                  painter: _RegionPainter(
                                                      polygons,
                                                      List.of(active))),
                                            ])),
                              )),
                        ))),
                Wrap(spacing: 12, children: [
                  TextButton(
                      onPressed: () => setState(() {
                            if (active.isNotEmpty) {
                              active.removeLast();
                            } else if (polygons.isNotEmpty) {
                              polygons.removeLast();
                            }
                          }),
                      child: const Text('1つ戻す')),
                  TextButton(
                      onPressed: active.length >= 3 ? finishPolygon : null,
                      child: const Text('領域を追加')),
                  FilledButton(
                      onPressed: polygons.isEmpty && active.length < 3
                          ? null
                          : () {
                              finishPolygon();
                              if (active.isNotEmpty || polygons.isEmpty) return;
                              widget.session.setForegroundRegion(
                                  ForegroundRegion(polygons));
                              Navigator.pop(context);
                            },
                      child: const Text('この領域を使う')),
                ]),
                const SizedBox(height: 20),
              ]);
            }),
      );
}

class _RegionPainter extends CustomPainter {
  _RegionPainter(this.polygons, this.active);
  final List<List<({double x, double y})>> polygons;
  final List<({double x, double y})> active;
  @override
  void paint(Canvas canvas, Size size) {
    for (final points in [...polygons, active]) {
      if (points.isEmpty) continue;
      final path = Path()
        ..moveTo(points.first.x * size.width, points.first.y * size.height);
      for (final point in points.skip(1)) {
        path.lineTo(point.x * size.width, point.y * size.height);
      }
      if (!identical(points, active)) {
        path.close();
        canvas.drawPath(
            path, Paint()..color = Colors.green.withValues(alpha: .25));
      }
      canvas.drawPath(
          path,
          Paint()
            ..color = Colors.greenAccent
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2);
      for (final point in points) {
        canvas.drawCircle(Offset(point.x * size.width, point.y * size.height),
            3, Paint()..color = Colors.greenAccent);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _RegionPainter oldDelegate) => true;
}
