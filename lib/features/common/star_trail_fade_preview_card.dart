import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

import '../../core/preview/star_trail_fade_preview.dart';
import '../../core/stacking/star_trail_edge_fade.dart';
import '../../design/mobile_stack_theme.dart';

/// Shows a small, live-updating approximation of how the current fade
/// settings will taper the star trail's start/end, built from each
/// source's already-extracted embedded JPEG thumbnail (passed in via
/// [thumbnails]) rather than the real RAW pipeline.
///
/// This is intentionally an approximation — see
/// `star_trail_fade_preview.dart`'s doc comments — so the card always
/// labels itself as a simplified preview rather than implying it matches
/// the final export's exact brightness/resolution.
///
/// Takes [thumbnails] and [fadeSettings] as plain values (rather than
/// the whole `ProcessingSession`) specifically so [didUpdateWidget] can
/// tell "did the fade settings actually change" apart from "did
/// something unrelated in the session change" via simple `==` — the
/// settings screen wraps everything in one
/// `AnimatedBuilder(animation: session)`, which rebuilds this widget on
/// every session change, not just fade-setting ones. Recomposing only
/// when [fadeSettings] actually differs (rather than on every `build`)
/// avoids an unbounded rebuild loop.
class StarTrailFadePreviewCard extends StatefulWidget {
  const StarTrailFadePreviewCard({
    required this.thumbnails,
    required this.fadeSettings,
    super.key,
  });

  final List<Uint8List?> thumbnails;
  final StarTrailFadeSettings fadeSettings;

  @override
  State<StarTrailFadePreviewCard> createState() =>
      _StarTrailFadePreviewCardState();
}

class _StarTrailFadePreviewCardState extends State<StarTrailFadePreviewCard> {
  List<StarTrailPreviewFrame>? _frames;
  Uint8List? _composedPngBytes;
  bool _loading = true;
  Object? _loadError;

  @override
  void initState() {
    super.initState();
    _loadFrames();
  }

  @override
  void didUpdateWidget(covariant StarTrailFadePreviewCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.thumbnails.length != widget.thumbnails.length) {
      _loadFrames();
    } else if (oldWidget.fadeSettings != widget.fadeSettings) {
      _recompose();
    }
  }

  Future<void> _loadFrames() async {
    setState(() {
      _loading = true;
      _loadError = null;
      _frames = null;
      _composedPngBytes = null;
    });
    try {
      final List<StarTrailPreviewFrame> frames =
          await decodeStarTrailPreviewFrames(thumbnails: widget.thumbnails);
      if (!mounted) return;
      setState(() {
        _frames = frames;
        _loading = false;
      });
      _recompose();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _loadError = error;
        _loading = false;
      });
    }
  }

  void _recompose() {
    final List<StarTrailPreviewFrame>? frames = _frames;
    if (frames == null || frames.isEmpty) return;
    final result = composeStarTrailFadePreview(
      frames: frames,
      settings: widget.fadeSettings,
    );
    if (result == null || !mounted) return;
    // Encoding is synchronous but cheap at preview resolution (a couple
    // hundred pixels wide), so no isolate hop here — this runs directly
    // from a slider's `onChanged` by way of `didUpdateWidget` above.
    // `Image(..., numChannels: 3)` + `.toUint8List()` is the same
    // direct-backing-store pattern `export_result.dart` uses for its
    // JPEG encoder, rather than a less-certain `Image.fromBytes` call.
    final img.Image image = img.Image(
      width: result.width,
      height: result.height,
      numChannels: 3,
    );
    image.toUint8List().setAll(0, result.rgb);
    final Uint8List png = img.encodePng(image);
    setState(() => _composedPngBytes = png);
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: const <Widget>[
                Icon(Icons.visibility_outlined, size: 20),
                SizedBox(width: 8),
                Text(
                  'プレビュー（簡易）',
                  style: TextStyle(fontWeight: FontWeight.w800),
                ),
              ],
            ),
            const SizedBox(height: 8),
            AspectRatio(
              aspectRatio: 3 / 2,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.black,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: _buildPreviewContent(),
                ),
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              '選択済みRAWのサムネイルから作った簡易合成です。実際の書き出しとは解像度・色味が異なります。',
              style: TextStyle(color: MobileStackColors.muted, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPreviewContent() {
    if (_loadError != null) {
      return const Center(
        child: Text(
          'プレビューを作成できませんでした。',
          style: TextStyle(color: Colors.white70),
        ),
      );
    }
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 24,
          height: 24,
          child: CircularProgressIndicator(strokeWidth: 2.5),
        ),
      );
    }
    final Uint8List? bytes = _composedPngBytes;
    if (bytes == null) {
      return const Center(
        child: Text(
          'サムネイルがまだありません。',
          style: TextStyle(color: Colors.white70),
        ),
      );
    }
    return Image.memory(bytes, fit: BoxFit.contain, gaplessPlayback: true);
  }
}
