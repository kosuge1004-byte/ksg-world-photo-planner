import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;
import 'package:path/path.dart' as path;
import 'package:path_provider/path_provider.dart';

import '../../core/models/processing_mode.dart';
import '../../core/export/output_image_format.dart';
import '../../design/mobile_stack_theme.dart';
import 'result_file_actions.dart';

const int _mib = 1024 * 1024;
const int _maximumBrightnessSourceBytes = 96 * _mib;
const int _maximumBrightnessWorkingBytes = 384 * _mib;

Future<void> _writeBrightnessAdjustedJpeg({
  required String sourcePath,
  required String outputPath,
  required double gain,
}) async {
  await Isolate.run(() {
    final File source = File(sourcePath);
    final int sourceLength = source.lengthSync();
    if (sourceLength > _maximumBrightnessSourceBytes) {
      throw StateError(
        '画像ファイルが大きすぎるため、安全に明るさ調整できません。'
        '元画像をそのまま保存し、写真編集アプリで調整してください。',
      );
    }
    final Uint8List sourceBytes = source.readAsBytesSync();
    final img.JpegDecoder decoder = img.JpegDecoder();
    final img.DecodeInfo? info = decoder.startDecode(sourceBytes);
    if (info == null) {
      throw StateError('明るさ調整用のJPEG情報を読み取れませんでした。');
    }
    final int pixelCount = info.width * info.height;
    // Conservatively cover the decoded RGBA-sized plane, encoder workspace,
    // compressed input and compressed output before allocating the full image.
    final int estimatedWorkingBytes = pixelCount * 8 + sourceBytes.length * 3;
    if (estimatedWorkingBytes > _maximumBrightnessWorkingBytes) {
      throw StateError(
        '${info.width}×${info.height}の画像は明るさ調整時のメモリ上限を超えます。'
        '元画像をそのまま保存し、写真編集アプリで調整してください。',
      );
    }
    final img.Image? decoded = decoder.decodeFrame(0);
    if (decoded == null) {
      throw StateError('明るさ調整用の画像をデコードできませんでした。');
    }
    for (final img.Pixel pixel in decoded) {
      final num maximum = pixel.maxChannelValue;
      pixel
        ..r = (pixel.r * gain).clamp(0, maximum)
        ..g = (pixel.g * gain).clamp(0, maximum)
        ..b = (pixel.b * gain).clamp(0, maximum);
    }
    File(outputPath).writeAsBytesSync(
      img.encodeJpg(decoded, quality: 95),
      flush: true,
    );
  });
}

Future<void> deleteOwnedTemporaryResult(File imageFile) async {
  final Directory parent = imageFile.parent;
  final String directoryName = path.basename(parent.path);
  const List<String> ownedPrefixes = <String>[
    'mobile-stack-result-',
    'mobile-stack-meteor-result-',
    'mobile-stack-cfa-drizzle-result-',
  ];
  if (!ownedPrefixes.any(directoryName.startsWith)) return;
  try {
    if (await imageFile.exists()) await imageFile.delete();
    if (await parent.exists() && await parent.list().isEmpty) {
      await parent.delete();
    }
  } on FileSystemException {
    // Best effort. The OS may still be releasing an image/share handle.
  }
}

Future<void> _deleteFileBestEffort(File file) async {
  try {
    if (await file.exists()) await file.delete();
  } on FileSystemException {
    // The share/preview layer may still be releasing the file handle.
  }
}

class ResultScreen extends StatefulWidget {
  const ResultScreen({
    required this.mode,
    required this.imageFile,
    required this.frameCount,
    this.actions,
    this.deleteTemporaryResultOnDispose = true,
    super.key,
  });

  final ProcessingMode mode;
  final File imageFile;
  final int frameCount;
  final ResultFileActions? actions;
  final bool deleteTemporaryResultOnDispose;

  @override
  State<ResultScreen> createState() => _ResultScreenState();
}

enum _ResultAction { save, share }

class _ResultScreenState extends State<ResultScreen> {
  late final ResultFileActions _actions;
  _ResultAction? _activeAction;
  String? _savedLocation;

  // Gap between how this app auto-exposes a single frame vs. a stacked
  // result independently (see the auto-tone discussion that led to this)
  // means a stack can come out looking dimmer even though nothing was
  // actually lost. This lets the person compensate after the fact instead
  // of needing to re-run the whole stack with manually-matched exposure
  // parameters. Only offered for JPEG (the one displayed/re-encodable
  // raster format here) — TIFF16/Linear DNG intentionally keep full
  // untouched data for a real photo editor instead.
  double _evStops = 0;
  File? _adjustedFileForSave;
  double? _adjustedEvStops;

  bool get _busy => _activeAction != null;
  bool get _supportsBrightnessAdjustment => _format == OutputImageFormat.jpeg;
  OutputImageFormat get _format =>
      OutputImageFormat.fromPath(widget.imageFile.path);

  /// A brightness-only 4x5 color matrix multiplying RGB by 2^[_evStops],
  /// for live preview only (the actual saved/shared file is re-encoded
  /// separately in [_prepareAdjustedFileIfNeeded], since a ColorFilter is
  /// display-only and would not affect the exported bytes).
  ColorFilter _previewColorFilter() {
    final double gain = math.pow(2, _evStops).toDouble();
    return ColorFilter.matrix(<double>[
      gain,
      0,
      0,
      0,
      0,
      0,
      gain,
      0,
      0,
      0,
      0,
      0,
      gain,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ]);
  }

  @override
  void initState() {
    super.initState();
    _actions = widget.actions ?? PlatformResultFileActions();
  }

  @override
  void dispose() {
    if (widget.deleteTemporaryResultOnDispose) {
      unawaited(deleteOwnedTemporaryResult(widget.imageFile));
    }
    final File? adjusted = _adjustedFileForSave;
    if (adjusted != null) {
      unawaited(_deleteFileBestEffort(adjusted));
    }
    super.dispose();
  }

  /// Returns the file that should actually be saved/shared: the original
  /// if no brightness adjustment was made, or a re-encoded JPEG with the
  /// adjustment baked in otherwise. Re-encodes at most once per distinct
  /// [_evStops] value reached via the slider's "done changing" callback,
  /// not on every intermediate drag frame.
  Future<File> _resolveExportFile() async {
    if (_evStops == 0 || !_supportsBrightnessAdjustment) {
      return widget.imageFile;
    }
    final double targetEv = _evStops;
    final File? cached = _adjustedFileForSave;
    if (cached != null &&
        _adjustedEvStops == targetEv &&
        await cached.exists()) {
      return cached;
    }
    if (cached != null) await _deleteFileBestEffort(cached);
    _adjustedFileForSave = null;
    _adjustedEvStops = null;
    final double gain = math.pow(2, targetEv).toDouble();
    final Directory tempDir = await getTemporaryDirectory();
    final File output = File(
      '${tempDir.path}${Platform.pathSeparator}'
      'mobile-stack-brightness-adjusted-'
      '${DateTime.now().microsecondsSinceEpoch}.jpg',
    );
    // Full-resolution decode + per-pixel gain + JPEG encoding can take several
    // seconds on a phone. Keep the Flutter UI isolate free so saving a large
    // result cannot trigger an Android "app isn't responding" dialog.
    try {
      await _writeBrightnessAdjustedJpeg(
        sourcePath: widget.imageFile.path,
        outputPath: output.path,
        gain: gain,
      );
    } on Object {
      await _deleteFileBestEffort(output);
      rethrow;
    }
    _adjustedFileForSave = output;
    _adjustedEvStops = targetEv;
    return output;
  }

  Future<void> _saveCopy() async {
    if (_busy) return;
    setState(() => _activeAction = _ResultAction.save);
    try {
      final File exportFile = await _resolveExportFile();
      final String location = await _actions.saveCopy(
        sourceFile: exportFile,
        suggestedName: _suggestedFileName(),
      );
      if (!mounted) return;
      setState(() => _savedLocation = location);
      _showMessage('保存しました: $location');
    } catch (error) {
      if (mounted) _showMessage('保存できませんでした: $error');
    } finally {
      if (mounted) setState(() => _activeAction = null);
    }
  }

  Future<void> _share() async {
    if (_busy) return;
    setState(() => _activeAction = _ResultAction.share);
    try {
      final File exportFile = await _resolveExportFile();
      if (!mounted) return;
      final RenderBox? box = context.findRenderObject() as RenderBox?;
      final Rect? origin =
          box == null ? null : box.localToGlobal(Offset.zero) & box.size;
      await _actions.share(
        sourceFile: exportFile,
        sharePositionOrigin: origin,
      );
    } catch (error) {
      if (mounted) _showMessage('共有できませんでした: $error');
    } finally {
      if (mounted) setState(() => _activeAction = null);
    }
  }

  String _suggestedFileName() {
    final DateTime now = DateTime.now();
    String two(int value) => value.toString().padLeft(2, '0');
    return 'MobileStack_${widget.mode.name}_${now.year}'
        '${two(now.month)}${two(now.day)}_'
        '${two(now.hour)}${two(now.minute)}${two(now.second)}'
        '.${_format.extension}';
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<void>(
      canPop: !_busy,
      onPopInvokedWithResult: (bool didPop, void result) {
        if (!didPop && _busy) {
          _showMessage('保存・共有が終わるまでお待ちください。');
        }
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('結果')),
        body: StarfieldBackground(
          child: SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
              children: <Widget>[
                Text(
                  widget.mode.label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${widget.frameCount}枚のRAWから合成しました',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: MobileStackColors.muted),
                ),
                const SizedBox(height: 4),
                Text(
                  '${_format.label} · ${_format.detail}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: MobileStackColors.accent,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 18),
                ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: _format == OutputImageFormat.linearDng
                      ? const _LinearDngPreviewNotice()
                      : _format == OutputImageFormat.tiff16
                          ? const _TiffPreviewNotice()
                          : ColorFiltered(
                              colorFilter: _previewColorFilter(),
                              child: Image.file(
                                widget.imageFile,
                                cacheWidth: 2048,
                                fit: BoxFit.contain,
                                errorBuilder: (
                                  BuildContext context,
                                  Object error,
                                  StackTrace? stackTrace,
                                ) {
                                  return const _ImageLoadFailure();
                                },
                              ),
                            ),
                ),
                if (_supportsBrightnessAdjustment) ...<Widget>[
                  const SizedBox(height: 8),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          Row(
                            children: <Widget>[
                              const Icon(
                                Icons.exposure_rounded,
                                size: 18,
                                color: MobileStackColors.muted,
                              ),
                              const SizedBox(width: 8),
                              const Text(
                                '明るさ',
                                style: TextStyle(fontWeight: FontWeight.w800),
                              ),
                              const Spacer(),
                              Text(
                                _evStops == 0
                                    ? '±0 EV'
                                    : '${_evStops > 0 ? '+' : ''}'
                                        '${_evStops.toStringAsFixed(1)} EV',
                                style: const TextStyle(
                                  color: MobileStackColors.muted,
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                          Slider(
                            value: _evStops,
                            min: -2,
                            max: 2,
                            divisions: 40,
                            label: _evStops.toStringAsFixed(1),
                            onChanged: _busy
                                ? null
                                : (double value) {
                                    setState(() => _evStops = value);
                                  },
                            onChangeEnd: (double value) {
                              // Only re-encode once dragging settles, not on
                              // every intermediate frame — re-encoding a
                              // full-resolution JPEG on every slider tick
                              // would be wasteful and, per this session's
                              // broader memory-safety work, unnecessary
                              // extra pressure.
                              final File? stale = _adjustedFileForSave;
                              _adjustedFileForSave = null;
                              _adjustedEvStops = null;
                              if (stale != null) {
                                unawaited(_deleteFileBestEffort(stale));
                              }
                            },
                          ),
                          Text(
                            '保存・共有時にこの調整が画像へ反映されます。'
                            'デフォルトの明るさは撮影ごとに変えず固定基準で書き出しています'
                            '（Photoshop/Lightroomの露出と同じ考え方）。',
                            style: const TextStyle(
                              color: MobileStackColors.muted,
                              fontSize: 11,
                              height: 1.4,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: <Widget>[
                        const Icon(
                          Icons.insert_drive_file_outlined,
                          size: 18,
                          color: MobileStackColors.muted,
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            _savedLocation ?? widget.imageFile.path,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              color: MobileStackColors.muted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _busy ? null : _saveCopy,
                        icon: _activeAction == _ResultAction.save
                            ? const SizedBox.square(
                                dimension: 18,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.save_alt_rounded),
                        label: Text(
                          _activeAction == _ResultAction.save
                              ? '保存中…'
                              : '端末に保存',
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _busy ? null : _share,
                        icon: _activeAction == _ResultAction.share
                            ? const SizedBox.square(
                                dimension: 18,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.ios_share_rounded),
                        label: Text(
                          _activeAction == _ResultAction.share ? '共有中…' : '共有',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  _savedLocation == null
                      ? '結果は一時ファイルです。必要な画像は端末へ保存してください。'
                      : '保存済みです。元の一時ファイルは画面を閉じると削除されます。',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: MobileStackColors.muted,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () => Navigator.of(context).popUntil(
                            (Route<dynamic> route) => route.isFirst,
                          ),
                  child: const Text('ホームへ戻る'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _LinearDngPreviewNotice extends StatelessWidget {
  const _LinearDngPreviewNotice();

  @override
  Widget build(BuildContext context) {
    return const AspectRatio(
      aspectRatio: 4 / 3,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Color(0xFF172236),
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  Icons.high_quality_rounded,
                  size: 48,
                  color: MobileStackColors.accent,
                ),
                SizedBox(height: 12),
                Text(
                  'Linear DNGを作成しました',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
                SizedBox(height: 6),
                Text(
                  '32bit浮動小数の線形データです。露出・トーン・LUT・ガンマは'
                  '焼き込まず、対応するRAW現像アプリで調整できます。',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: MobileStackColors.muted,
                    fontSize: 12,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TiffPreviewNotice extends StatelessWidget {
  const _TiffPreviewNotice();

  @override
  Widget build(BuildContext context) {
    return const AspectRatio(
      aspectRatio: 4 / 3,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Color(0xFF172236),
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  Icons.high_quality_rounded,
                  size: 48,
                  color: MobileStackColors.accent,
                ),
                SizedBox(height: 12),
                Text(
                  '16bit TIFFを作成しました',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
                SizedBox(height: 6),
                Text(
                  '高階調データは端末へ保存または共有して、写真編集アプリで確認できます。'
                  '4 GiB超相当の大容量画像はBigTIFFへ自動切替します。',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: MobileStackColors.muted,
                    fontSize: 12,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ImageLoadFailure extends StatelessWidget {
  const _ImageLoadFailure();

  @override
  Widget build(BuildContext context) {
    return const AspectRatio(
      aspectRatio: 4 / 3,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Color(0xFF29313F),
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  Icons.broken_image_outlined,
                  size: 40,
                  color: MobileStackColors.muted,
                ),
                SizedBox(height: 8),
                Text(
                  '画像を表示できませんでした',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: MobileStackColors.muted),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
