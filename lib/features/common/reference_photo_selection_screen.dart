import 'package:flutter/material.dart';

import '../../core/io/raw_input_contract.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/raw_format.dart';
import '../../design/mobile_stack_theme.dart';

/// Selects one reference RAW by its stable source path, never by a mutable
/// list index. [files] is a snapshot preserving the user's original order.
class ReferencePhotoSelectionScreen extends StatefulWidget {
  const ReferencePhotoSelectionScreen({
    required this.files,
    required this.mode,
    this.initialReferencePath,
    super.key,
  });

  final List<RawInputFile> files;
  final ProcessingMode mode;
  final String? initialReferencePath;

  @override
  State<ReferencePhotoSelectionScreen> createState() =>
      _ReferencePhotoSelectionScreenState();
}

class _ReferencePhotoSelectionScreenState
    extends State<ReferencePhotoSelectionScreen> {
  String? _selectedPath;

  @override
  void initState() {
    super.initState();
    _selectedPath = widget.files.any(
      (RawInputFile file) => file.path == widget.initialReferencePath,
    )
        ? widget.initialReferencePath
        : null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('基準写真を選択')),
      body: StarfieldBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 16, 14, 100),
            children: <Widget>[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(
                    widget.mode == ProcessingMode.starTrail
                        ? '色・明るさの基準にする写真を1枚選んでください。設定で「地上の一時的な光を抑える」をONにすると、この写真の地上部分を保護するためにも使います。'
                        : '位置合わせ・最終出力の基準にする1枚を選択してください',
                    style: const TextStyle(
                      color: MobileStackColors.muted,
                      fontSize: 12,
                      height: 1.5,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              for (int index = 0; index < widget.files.length; index++)
                _ReferencePhotoChoice(
                  key: ValueKey<String>(widget.files[index].path),
                  file: widget.files[index],
                  originalSequence: index + 1,
                  selected: widget.files[index].path == _selectedPath,
                  onTap: () =>
                      setState(() => _selectedPath = widget.files[index].path),
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
              onPressed: _selectedPath == null
                  ? null
                  : () => Navigator.of(context).pop(_selectedPath),
              icon: const Icon(Icons.check_rounded),
              label: const Text('この写真を基準にする'),
            ),
          ),
        ),
      ),
    );
  }
}

class _ReferencePhotoChoice extends StatelessWidget {
  const _ReferencePhotoChoice({
    required this.file,
    required this.originalSequence,
    required this.selected,
    required this.onTap,
    super.key,
  });

  final RawInputFile file;
  final int originalSequence;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final metadata = file.metadata;
    final String rawFormat = file.probe?.format.label ?? 'RAW形式不明';
    final String imageDetail = metadata == null
        ? '画像情報不明'
        : '${metadata.width}×${metadata.height} · '
            '${metadata.cfaPattern.name.toUpperCase()}';
    final bytes = file.thumbnailBytes;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        selected: selected,
        button: true,
        label: '選択順 $originalSequence、${file.name}、$rawFormat',
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: MobileStackColors.surfaceHigh,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: selected
                    ? const Color(0xFF4FC3F7)
                    : MobileStackColors.outline,
                width: selected ? 2 : 1,
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: <Widget>[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: SizedBox(
                      width: 82,
                      height: 62,
                      child: bytes == null
                          ? const ColoredBox(
                              color: Color(0xFF0A0D14),
                              child: Icon(
                                Icons.photo_outlined,
                                color: MobileStackColors.muted,
                              ),
                            )
                          : Image.memory(bytes, fit: BoxFit.cover),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          file.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '選択順 $originalSequence · $rawFormat',
                          style: const TextStyle(
                            color: Color(0xFF4FC3F7),
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          imageDetail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            fontSize: 10,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(
                    selected
                        ? Icons.radio_button_checked_rounded
                        : Icons.radio_button_unchecked_rounded,
                    color: selected
                        ? const Color(0xFF4FC3F7)
                        : MobileStackColors.muted,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
