import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../core/focus_stack/focus_marking_preview_model.dart';
import '../../design/mobile_stack_theme.dart';

class FocusMarkingReviewScreen extends StatefulWidget {
  const FocusMarkingReviewScreen({
    super.key,
    required this.initialModel,
    required this.showOmissionCandidates,
    required this.onConfirmed,
  });

  final FocusMarkingPreviewModel initialModel;
  final bool showOmissionCandidates;
  final ValueChanged<FocusMarkingPreviewModel> onConfirmed;

  @override
  State<FocusMarkingReviewScreen> createState() =>
      _FocusMarkingReviewScreenState();
}

class _FocusMarkingReviewScreenState extends State<FocusMarkingReviewScreen> {
  late FocusMarkingPreviewModel _model;
  int _currentIndex = 0;
  bool _showMarking = true;

  @override
  void initState() {
    super.initState();
    _model = widget.initialModel;
  }

  void _setSelected(int index, bool selected) {
    if (_model.frames[index].isReference && !selected) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('基準写真は深度合成から除外できません。')),
      );
      return;
    }
    final FocusMarkingPreviewModel next =
        _model.withFrameSelection(index, selected);
    if (identical(next, _model) && !selected) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('深度合成には最低2枚必要です。')),
      );
      return;
    }
    setState(() => _model = next);
  }

  @override
  Widget build(BuildContext context) {
    final FocusMarkingPreviewFrame current = _model.frames[_currentIndex];
    return Scaffold(
      appBar: AppBar(
        title: const Text('合焦位置を確認'),
      ),
      body: StarfieldBackground(
        child: SafeArea(
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 8),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        '${_currentIndex + 1} / ${_model.frames.length}  ${current.input.name}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    if (current.isReference) ...<Widget>[
                      const SizedBox(width: 8),
                      const _ReferenceBadge(),
                      const SizedBox(width: 8),
                    ],
                    Switch(
                      value: _showMarking,
                      onChanged: (bool value) =>
                          setState(() => _showMarking = value),
                    ),
                    const Text(
                      'マーキング',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  child: _FocusPreviewImage(
                    frame: current,
                    showMarking: _showMarking,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _FrameInfoBar(
                frame: current,
                showOmissionCandidate: widget.showOmissionCandidates,
                onSelectedChanged: (bool value) =>
                    _setSelected(_currentIndex, value),
              ),
              SizedBox(
                height: 92,
                child: ListView.separated(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                  scrollDirection: Axis.horizontal,
                  itemCount: _model.frames.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (BuildContext context, int index) {
                    final FocusMarkingPreviewFrame frame = _model.frames[index];
                    return _FocusFrameThumbnail(
                      frame: frame,
                      active: index == _currentIndex,
                      showOmissionCandidate: widget.showOmissionCandidates,
                      onTap: () => setState(() => _currentIndex = index),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: Material(
        color: const Color(0xF2070A12),
        elevation: 16,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
            child: FilledButton.icon(
              onPressed: _model.selectedCount >= 2
                  ? () => widget.onConfirmed(_model)
                  : null,
              icon: const Icon(Icons.check_rounded),
              label: Text(
                '使用する${_model.selectedCount}枚を確定',
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FocusPreviewImage extends StatelessWidget {
  const _FocusPreviewImage({
    required this.frame,
    required this.showMarking,
  });

  final FocusMarkingPreviewFrame frame;
  final bool showMarking;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: DecoratedBox(
        decoration: const BoxDecoration(
          color: Color(0xFF0A0D14),
        ),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            return Stack(
              fit: StackFit.expand,
              children: <Widget>[
                _ExactFocusPreviewImage(frame: frame),
                if (showMarking)
                  IgnorePointer(
                    child: _FocusMaskImage(frame: frame),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _ExactFocusPreviewImage extends StatefulWidget {
  const _ExactFocusPreviewImage({required this.frame});

  final FocusMarkingPreviewFrame frame;

  @override
  State<_ExactFocusPreviewImage> createState() =>
      _ExactFocusPreviewImageState();
}

class _ExactFocusPreviewImageState extends State<_ExactFocusPreviewImage> {
  ui.Image? _image;

  @override
  void initState() {
    super.initState();
    _decode();
  }

  @override
  void didUpdateWidget(covariant _ExactFocusPreviewImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.frame.frameIndex != widget.frame.frameIndex ||
        oldWidget.frame.exactPreviewLuminance8 !=
            widget.frame.exactPreviewLuminance8) {
      _image?.dispose();
      _image = null;
      _decode();
    }
  }

  Future<void> _decode() async {
    final FocusMarkingPreviewFrame frame = widget.frame;
    final Uint8List rgba =
        Uint8List(frame.exactPreviewWidth * frame.exactPreviewHeight * 4);
    for (int pixel = 0; pixel < frame.exactPreviewLuminance8.length; pixel++) {
      final int value = frame.exactPreviewLuminance8[pixel];
      final int base = pixel * 4;
      rgba[base] = value;
      rgba[base + 1] = value;
      rgba[base + 2] = value;
      rgba[base + 3] = 255;
      // Building a megapixel RGBA preview is pure Dart work on the UI isolate.
      // Yield in bounded chunks so image review cannot monopolize Android's
      // event loop long enough to be classified as an ANR.
      if ((pixel & 0xffff) == 0xffff) {
        await Future<void>.delayed(Duration.zero);
        if (!mounted || widget.frame.frameIndex != frame.frameIndex) return;
      }
    }
    final ui.ImmutableBuffer buffer =
        await ui.ImmutableBuffer.fromUint8List(rgba);
    final ui.ImageDescriptor descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: frame.exactPreviewWidth,
      height: frame.exactPreviewHeight,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    final ui.Codec codec = await descriptor.instantiateCodec();
    final ui.FrameInfo info = await codec.getNextFrame();
    codec.dispose();
    descriptor.dispose();
    buffer.dispose();
    if (!mounted || widget.frame.frameIndex != frame.frameIndex) {
      info.image.dispose();
      return;
    }
    setState(() => _image = info.image);
  }

  @override
  void dispose() {
    _image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ui.Image? image = _image;
    if (image == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return RawImage(
      image: image,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.medium,
    );
  }
}

class _FocusMaskImage extends StatefulWidget {
  const _FocusMaskImage({required this.frame});

  final FocusMarkingPreviewFrame frame;

  @override
  State<_FocusMaskImage> createState() => _FocusMaskImageState();
}

class _FocusMaskImageState extends State<_FocusMaskImage> {
  ui.Image? _image;

  @override
  void initState() {
    super.initState();
    _decode();
  }

  @override
  void didUpdateWidget(covariant _FocusMaskImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.frame.frameIndex != widget.frame.frameIndex ||
        oldWidget.frame.markingMask != widget.frame.markingMask) {
      _image?.dispose();
      _image = null;
      _decode();
    }
  }

  Future<void> _decode() async {
    final FocusMarkingPreviewFrame frame = widget.frame;
    final int outputWidth = frame.exactPreviewWidth;
    final int outputHeight = frame.exactPreviewHeight;
    final Uint8List rgba = Uint8List(outputWidth * outputHeight * 4);
    for (int outputY = 0; outputY < outputHeight; outputY++) {
      final int y0 = outputY * frame.markingHeight ~/ outputHeight;
      final int y1 = math.max(
        y0 + 1,
        ((outputY + 1) * frame.markingHeight + outputHeight - 1) ~/
            outputHeight,
      );
      for (int outputX = 0; outputX < outputWidth; outputX++) {
        final int x0 = outputX * frame.markingWidth ~/ outputWidth;
        final int x1 = math.max(
          x0 + 1,
          ((outputX + 1) * frame.markingWidth + outputWidth - 1) ~/ outputWidth,
        );
        int marked = 0;
        int count = 0;
        for (int y = y0; y < y1; y++) {
          final int row = y * frame.markingWidth;
          for (int x = x0; x < x1; x++) {
            if (frame.markingMask[row + x] != 0) marked++;
            count++;
          }
        }
        if (marked == 0) continue;
        final int base = (outputY * outputWidth + outputX) * 4;
        rgba[base] = 255;
        rgba[base + 1] = 155;
        rgba[base + 2] = 101;
        rgba[base + 3] = (0x66 * marked / count).round().clamp(1, 0x66);
      }
      // Downsampling a full-resolution marking mask visits essentially every
      // source-mask pixel. Cooperatively yield every few output rows instead
      // of blocking the UI isolate for the entire full-resolution scan.
      if ((outputY & 0x0f) == 0x0f) {
        await Future<void>.delayed(Duration.zero);
        if (!mounted || widget.frame.frameIndex != frame.frameIndex) return;
      }
    }
    final ui.ImmutableBuffer buffer =
        await ui.ImmutableBuffer.fromUint8List(rgba);
    final ui.ImageDescriptor descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: outputWidth,
      height: outputHeight,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    final ui.Codec codec = await descriptor.instantiateCodec();
    final ui.FrameInfo info = await codec.getNextFrame();
    codec.dispose();
    descriptor.dispose();
    buffer.dispose();
    if (!mounted || widget.frame.frameIndex != frame.frameIndex) {
      info.image.dispose();
      return;
    }
    setState(() => _image = info.image);
  }

  @override
  void dispose() {
    _image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ui.Image? image = _image;
    if (image == null) return const SizedBox.expand();
    return RawImage(
      image: image,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.none,
    );
  }
}

class _FrameInfoBar extends StatelessWidget {
  const _FrameInfoBar({
    required this.frame,
    required this.showOmissionCandidate,
    required this.onSelectedChanged,
  });

  final FocusMarkingPreviewFrame frame;
  final bool showOmissionCandidate;
  final ValueChanged<bool> onSelectedChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 0),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: MobileStackColors.surfaceHigh,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: MobileStackColors.outline),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
          child: Row(
            children: <Widget>[
              Checkbox(
                value: frame.selected,
                onChanged: frame.isReference
                    ? null
                    : (bool? value) => onSelectedChanged(value ?? false),
              ),
              Text(
                frame.isReference ? '基準写真・使用する' : '使用する',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  '合焦マーキング ${(frame.markedFraction * 100).toStringAsFixed(1)}%',
                  style: const TextStyle(
                    color: MobileStackColors.muted,
                    fontSize: 11,
                  ),
                ),
              ),
              if (showOmissionCandidate && frame.omissionCandidate)
                const _OmissionBadge(),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReferenceBadge extends StatelessWidget {
  const _ReferenceBadge();

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0x334FC3F7),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0xFF4FC3F7)),
      ),
      child: const Padding(
        padding: EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        child: Text(
          '基準',
          style: TextStyle(
            color: Color(0xFFB3E5FC),
            fontSize: 10,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}

class _FocusFrameThumbnail extends StatelessWidget {
  const _FocusFrameThumbnail({
    required this.frame,
    required this.active,
    required this.showOmissionCandidate,
    required this.onTap,
  });

  final FocusMarkingPreviewFrame frame;
  final bool active;
  final bool showOmissionCandidate;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Uint8List? thumbnail = frame.input.thumbnailBytes;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 78,
        decoration: BoxDecoration(
          color: MobileStackColors.surfaceHigh,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: active ? const Color(0xFFF08A5D) : MobileStackColors.outline,
            width: active ? 2 : 1,
          ),
        ),
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: thumbnail != null
                  ? Image.memory(thumbnail, fit: BoxFit.cover)
                  : const Icon(
                      Icons.photo_outlined,
                      color: MobileStackColors.muted,
                    ),
            ),
            Positioned(
              left: 3,
              top: 3,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: const Color(0xCC070A12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  child: Text(
                    '${frame.frameIndex + 1}',
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
            if (!frame.selected)
              const ColoredBox(
                color: Color(0x88000000),
                child: Center(
                  child: Icon(Icons.block_rounded, color: Colors.white),
                ),
              ),
            if (showOmissionCandidate && frame.omissionCandidate)
              const Positioned(
                right: 3,
                top: 3,
                child: _OmissionBadge(),
              ),
          ],
        ),
      ),
    );
  }
}

class _OmissionBadge extends StatelessWidget {
  const _OmissionBadge();

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xCC8B5A2B),
        borderRadius: BorderRadius.circular(999),
      ),
      child: const Padding(
        padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Text(
          '省略候補',
          style: TextStyle(
            fontSize: 9,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}
