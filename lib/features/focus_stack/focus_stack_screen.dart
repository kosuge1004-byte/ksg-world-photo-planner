import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as path;

import '../../core/demosaic/demosaic_registry.dart';
import '../../core/background/stack_job_notifications.dart';
import '../../core/background/background_stack_controller.dart';
import '../common/standard_background_progress_screen.dart';
import '../../core/demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../../core/demosaic/native_mobile_stack_demosaic_engine.dart';
import '../../core/focus_stack/focus_marking_analysis_pipeline.dart';
import '../../core/focus_stack/focus_marking_preview_model.dart';
import '../../core/focus_stack/focus_stack_input_validator.dart';
import '../../core/focus_stack/focus_stack_pipeline.dart';
import '../../core/focus_stack/focus_stack_export.dart';
import '../../core/io/file_picker_raw_input_reader.dart';
import '../../core/export/output_image_format.dart';
import '../../core/export/lightroom_storage_preset.dart';
import '../../core/settings/app_settings.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/raw/raw_format.dart';
import '../../design/mobile_stack_theme.dart';
import '../common/result_file_actions.dart';
import 'focus_marking_review_screen.dart';
import 'focus_stack_settings_screen.dart';

class FocusStackScreen extends StatefulWidget {
  const FocusStackScreen({super.key});

  static const String routeName = '/focus-stack';

  @override
  State<FocusStackScreen> createState() => _FocusStackScreenState();
}

class _FocusStackScreenState extends State<FocusStackScreen> {
  final FilePickerRawInputReader _reader = FilePickerRawInputReader(
    metadataProbe: createProductionNativeRawMetadataProbe(),
    allowedExtensions: const <String>{'arw', 'nef', 'nrw'},
  );
  final ResultFileActions _resultFileActions = PlatformResultFileActions();
  final List<RawInputFile> _files = <RawInputFile>[];
  String? _referencePath;
  bool _isPicking = false;
  bool _isAnalyzing = false;
  bool _isStacking = false;
  bool _isSaving = false;
  bool _showOmissionCandidates = true;
  bool _autoExcludeOmissionCandidates = false;
  double _progress = 0;
  String _stage = '';
  FocusStackPipelineResult? _lastResult;
  String? _lastSavedPath;
  OutputImageFormat _outputFormat = AppSettings.defaultOutputFormat;
  LightroomStoragePreset _storagePreset = AppSettings.defaultStoragePreset;

  FocusStackInputValidation get _validation => validateFocusStackInputs(_files);

  @override
  void initState() {
    super.initState();
    _loadOutputSettings();
    unawaited(StackJobNotifications.requestPermission());
  }

  Future<void> _loadOutputSettings() async {
    final List<Object> values = await Future.wait<Object>(<Future<Object>>[
      AppSettings.loadOutputFormat(),
      AppSettings.loadStoragePreset(),
    ]);
    if (!mounted) return;
    setState(() {
      _outputFormat = values[0] as OutputImageFormat;
      _storagePreset = values[1] as LightroomStoragePreset;
    });
  }

  @override
  void dispose() {
    final FocusStackPipelineResult? result = _lastResult;
    // DNG export reads the file-backed result asynchronously. Do not delete
    // that store underneath an in-flight save; the save's finally block owns
    // cleanup after this State becomes unmounted.
    if (result != null && !_isSaving) {
      unawaited(result.dispose());
    }
    super.dispose();
  }

  Future<void> _pickRawFiles() async {
    if (_isPicking) return;
    setState(() => _isPicking = true);
    try {
      final RawSelectionResult selection = await _reader.selectRawFiles();
      final Set<String> known = _files.map((RawInputFile f) => f.path).toSet();
      setState(() {
        for (final RawInputFile file in selection.files) {
          if (known.add(file.path)) _files.add(file);
        }
      });
      if (!mounted || selection.rejected.isEmpty) return;
      final RawInputRejection first = selection.rejected.first;
      final String subject = selection.rejected.length == 1
          ? first.name
          : '${selection.rejected.length}件';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$subjectを追加できませんでした：${first.reason}')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('RAWファイルを読み込めませんでした：$error')),
      );
    } finally {
      if (mounted) setState(() => _isPicking = false);
    }
  }

  void _removeAt(int index) {
    setState(() {
      final RawInputFile removed = _files.removeAt(index);
      if (_referencePath == removed.path) _referencePath = null;
    });
  }

  Future<void> _selectReferencePhoto() async {
    if (_files.length < 2 || _isAnalyzing || _isStacking || _isSaving) return;
    final String? selected = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(
        builder: (_) => _FocusReferenceSelectionScreen(
          files: List<RawInputFile>.unmodifiable(_files),
          initialReferencePath: _referencePath,
        ),
      ),
    );
    if (!mounted || selected == null) return;
    setState(() => _referencePath = selected);
  }

  Future<bool> _openFocusSettings() async {
    final FocusStackSettingsResult? result =
        await Navigator.of(context).push<FocusStackSettingsResult>(
      MaterialPageRoute<FocusStackSettingsResult>(
        builder: (_) => FocusStackSettingsScreen(
          outputFormat: _outputFormat,
          storagePreset: _storagePreset,
          showOmissionCandidates: _showOmissionCandidates,
          autoExcludeOmissionCandidates: _autoExcludeOmissionCandidates,
        ),
      ),
    );
    if (!mounted || result == null) return false;
    setState(() {
      _outputFormat = result.outputFormat;
      _storagePreset = result.storagePreset;
      _showOmissionCandidates = result.showOmissionCandidates;
      _autoExcludeOmissionCandidates = result.autoExcludeOmissionCandidates;
    });
    return true;
  }

  int get _referenceIndex {
    final String? path = _referencePath;
    if (path == null) return -1;
    return _files.indexWhere((RawInputFile file) => file.path == path);
  }

  void _move(int from, int delta) {
    final int to = from + delta;
    if (to < 0 || to >= _files.length) return;
    setState(() {
      final RawInputFile file = _files.removeAt(from);
      _files.insert(to, file);
    });
  }

  DemosaicRegistry _createProductionDemosaicRegistry() =>
      DemosaicRegistry(<NativeMobileStackDemosaicEngine>[
        NativeMobileStackDemosaicEngine(),
      ]);

  Future<void> _analyzeAndReview() async {
    if (!_validation.isValid || _isAnalyzing || _isStacking || _isSaving) {
      return;
    }
    int referenceIndex = _referenceIndex;
    if (referenceIndex < 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('先に基準写真を1枚選択してください。')),
      );
      await _selectReferencePhoto();
      if (!mounted) return;
      referenceIndex = _referenceIndex;
      if (referenceIndex < 0) return;
    }
    if (!await _openFocusSettings()) return;

    final FocusStackPipelineResult? previousResult = _lastResult;
    if (previousResult != null) {
      // Work230+ owns a file-backed final RGB store. Dispose it before dropping
      // the UI reference so repeated analyses cannot leak large temp files.
      await previousResult.dispose();
    }
    if (!mounted) return;
    if (Platform.isAndroid) {
      setState(() {
        _isAnalyzing = true;
        _progress = 0;
        _stage = 'バックグラウンド合焦位置解析を開始';
        _lastResult = null;
        _lastSavedPath = null;
      });
      try {
        final BackgroundStackLaunch launch =
            await BackgroundStackController.startFocusMarking(
          inputs: List<RawInputFile>.unmodifiable(_files),
          referenceIndex: referenceIndex,
          showOmissionCandidates: _showOmissionCandidates,
          autoExcludeOmissionCandidates: _autoExcludeOmissionCandidates,
          outputFormatName: _outputFormat.name,
          storagePresetName: _storagePreset.name,
        );
        if (!mounted) return;
        await Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => StandardBackgroundProgressScreen.resume(
              launch: launch,
            ),
          ),
        );
      } catch (error) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('合焦位置解析を開始できませんでした：$error')),
        );
      } finally {
        if (mounted) {
          setState(() {
            _isAnalyzing = false;
            if (!_isStacking) {
              _progress = 0;
              _stage = '';
            }
          });
        }
      }
      return;
    }
    setState(() {
      _isAnalyzing = true;
      _progress = 0;
      _stage = '合焦位置解析を開始';
      _lastResult = null;
      _lastSavedPath = null;
    });
    try {
      final FocusMarkingAnalysisResult analysis = await analyzeFocusMarking(
        inputs: List<RawInputFile>.unmodifiable(_files),
        rawDecoderRegistry: createProductionNativeRawDecoderRegistry(),
        demosaicRegistry: _createProductionDemosaicRegistry(),
        referenceIndex: referenceIndex,
        reportProgress: ({
          required double fraction,
          required String stage,
          required int completedFrames,
          required int totalFrames,
        }) {
          if (!mounted) return;
          setState(() {
            _progress = fraction;
            _stage = stage;
          });
        },
      );
      if (!mounted) return;
      final FocusMarkingPreviewModel model = buildFocusMarkingPreviewModel(
        inputs: List<RawInputFile>.unmodifiable(_files),
        marking: analysis.marking,
        exactPreviews: analysis.exactPreviews,
        autoExclude: _autoExcludeOmissionCandidates,
        referenceFrameIndex: referenceIndex,
      );
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => FocusMarkingReviewScreen(
            initialModel: model,
            showOmissionCandidates: _showOmissionCandidates,
            onConfirmed: (FocusMarkingPreviewModel confirmed) {
              Navigator.of(context).pop();
              _runConfirmedStack(
                confirmed.selectedInputs,
                referencePath: _referencePath!,
              );
            },
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('合焦位置を解析できませんでした：$error')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isAnalyzing = false;
          if (!_isStacking) {
            _progress = 0;
            _stage = '';
          }
        });
      }
    }
  }

  Future<void> _runConfirmedStack(
    List<RawInputFile> selectedInputs, {
    required String referencePath,
  }) async {
    if (selectedInputs.length < 2 || _isStacking) return;
    final int selectedReferenceIndex = selectedInputs.indexWhere(
      (RawInputFile input) => input.path == referencePath,
    );
    if (selectedReferenceIndex < 0) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('基準写真は深度合成から除外できません。')),
        );
      }
      return;
    }
    if (!Platform.isAndroid) {
      await _runConfirmedStackForeground(
        selectedInputs,
        referenceIndex: selectedReferenceIndex,
      );
      return;
    }
    final FocusStackPipelineResult? previousResult = _lastResult;
    if (previousResult != null) await previousResult.dispose();
    if (!mounted) return;
    setState(() {
      _isStacking = true;
      _progress = 0;
      _stage = 'バックグラウンド深度合成を開始';
      _lastResult = null;
      _lastSavedPath = null;
    });
    try {
      final BackgroundStackLaunch launch =
          await BackgroundStackController.startFocusStack(
        inputs: selectedInputs,
        referenceIndex: selectedReferenceIndex,
        outputFormatName: _outputFormat.name,
        storagePresetName: _storagePreset.name,
      );
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => StandardBackgroundProgressScreen.resume(
            launch: launch,
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('深度合成を開始できませんでした：$error')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isStacking = false;
          _progress = 0;
          _stage = '';
        });
      }
    }
  }

  Future<void> _runConfirmedStackForeground(
    List<RawInputFile> selectedInputs, {
    required int referenceIndex,
  }) async {
    final FocusStackPipelineResult? previousResult = _lastResult;
    if (previousResult != null) await previousResult.dispose();
    if (!mounted) return;
    setState(() {
      _isStacking = true;
      _progress = 0;
      _stage = '深度合成を開始';
      _lastResult = null;
    });
    try {
      final FocusStackPipelineResult result = await runFocusStackPipeline(
        inputs: selectedInputs,
        rawDecoderRegistry: createProductionNativeRawDecoderRegistry(),
        demosaicRegistry: _createProductionDemosaicRegistry(),
        referenceIndex: referenceIndex,
        reportProgress: ({
          required double fraction,
          required String stage,
          required int completedFrames,
          required int totalFrames,
        }) {
          if (!mounted) return;
          setState(() {
            _progress = fraction;
            _stage = stage;
          });
        },
      );
      if (!mounted) {
        await result.dispose();
        return;
      }
      setState(() => _lastResult = result);
      try {
        await StackJobNotifications.showTaskCompleted(
          jobLabel: '深度合成',
          message: '深度合成画像の生成が完了しました。',
        );
      } on Object {
        // Notification permission/failure must not affect the completed stack.
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text('深度合成画像を生成しました（${result.width}×${result.height}）。')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('深度合成に失敗しました：$error')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isStacking = false;
          _progress = 0;
          _stage = '';
        });
      }
    }
  }

  Future<void> _saveLastResult() async {
    final FocusStackPipelineResult? result = _lastResult;
    if (result == null || _isSaving || _isAnalyzing || _isStacking) return;

    final DateTime now = DateTime.now();
    final String stamp = '${now.year.toString().padLeft(4, '0')}'
        '${now.month.toString().padLeft(2, '0')}'
        '${now.day.toString().padLeft(2, '0')}_'
        '${now.hour.toString().padLeft(2, '0')}'
        '${now.minute.toString().padLeft(2, '0')}'
        '${now.second.toString().padLeft(2, '0')}';
    final OutputImageFormat format = _outputFormat;
    final String fileName = 'focus_stack_$stamp.${format.extension}';

    setState(() {
      _isSaving = true;
      _stage = '${format.label}を書き出し';
      _progress = 0;
      _lastSavedPath = null;
    });
    Directory? stagingDirectory;
    try {
      stagingDirectory = await Directory.systemTemp.createTemp(
        'mobile-stack-focus-export-',
      );
      final File stagedFile = File(path.join(stagingDirectory.path, fileName));
      await exportFocusStackResult(
        result: result,
        outputPath: stagedFile.path,
        format: format,
        linearDngCompression: _storagePreset.dngCompression,
      );
      final String savedLocation = await _resultFileActions.saveCopy(
        sourceFile: stagedFile,
        suggestedName: fileName,
      );
      if (!mounted) return;
      setState(() => _lastSavedPath = savedLocation);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${format.label}を保存しました：$savedLocation')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${format.label}を保存できませんでした：$error')),
      );
    } finally {
      final Directory? temporary = stagingDirectory;
      try {
        if (temporary != null && await temporary.exists()) {
          await temporary.delete(recursive: true);
        }
      } on FileSystemException catch (error) {
        debugPrint('出力一時フォルダを削除できませんでした: $error');
      }
      if (mounted) {
        setState(() {
          _isSaving = false;
          _progress = 0;
          _stage = '';
        });
      } else {
        await result.dispose();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final FocusStackInputValidation validation = _validation;
    return Scaffold(
      appBar: AppBar(title: const Text('深度合成')),
      body: StarfieldBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 16, 14, 120),
            children: <Widget>[
              const _FocusStackIntroCard(),
              const SizedBox(height: 14),
              _InputCard(
                files: _files,
                validation: validation,
                isPicking: _isPicking,
                onAdd: _pickRawFiles,
                onRemove: _removeAt,
                onMove: _move,
                onClear: () => setState(_files.clear),
              ),
              const SizedBox(height: 14),
              if (_isAnalyzing || _isStacking || _isSaving)
                _FocusProgressCard(
                  fraction: _progress,
                  stage: _stage,
                ),
              if (_isAnalyzing || _isStacking || _isSaving)
                const SizedBox(height: 14),
              if (_lastResult != null)
                _FocusResultCard(
                  result: _lastResult!,
                  saving: _isSaving,
                  savedPath: _lastSavedPath,
                  onSave: _saveLastResult,
                  outputFormat: _outputFormat,
                ),
              if (_lastResult != null) const SizedBox(height: 14),
              const _QualityPolicyCard(),
            ],
          ),
        ),
      ),
      bottomNavigationBar: _BottomBar(
        validation: validation,
        busy: _isAnalyzing || _isStacking || _isSaving,
        onPressed: _analyzeAndReview,
      ),
    );
  }
}

// ignore: unused_element
class _ReferenceSelectionCard extends StatelessWidget {
  const _ReferenceSelectionCard({
    required this.files,
    required this.referencePath,
    required this.onSelect,
  });

  final List<RawInputFile> files;
  final String? referencePath;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    RawInputFile? selected;
    final String? path = referencePath;
    if (path != null) {
      for (final RawInputFile file in files) {
        if (file.path == path) {
          selected = file;
          break;
        }
      }
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Row(
              children: <Widget>[
                Icon(Icons.center_focus_strong_rounded,
                    color: Color(0xFF4FC3F7)),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '基準写真',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              selected == null
                  ? '位置合わせの基準にする写真を1枚選択してください。'
                  : '選択中：${selected.name}',
              style: TextStyle(
                color: selected == null
                    ? MobileStackColors.warning
                    : MobileStackColors.muted,
                fontSize: 12,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: files.length >= 2 ? onSelect : null,
              icon: Icon(
                selected == null
                    ? Icons.photo_library_outlined
                    : Icons.change_circle_outlined,
              ),
              label: Text(selected == null ? '基準写真を選択' : '基準写真を変更'),
            ),
          ],
        ),
      ),
    );
  }
}

class _FocusReferenceSelectionScreen extends StatefulWidget {
  const _FocusReferenceSelectionScreen({
    required this.files,
    required this.initialReferencePath,
  });

  final List<RawInputFile> files;
  final String? initialReferencePath;

  @override
  State<_FocusReferenceSelectionScreen> createState() =>
      _FocusReferenceSelectionScreenState();
}

class _FocusReferenceSelectionScreenState
    extends State<_FocusReferenceSelectionScreen> {
  String? _selectedPath;

  @override
  void initState() {
    super.initState();
    _selectedPath = widget.initialReferencePath;
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
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(14),
                  child: Text(
                    'この写真を中心に他の写真を位置合わせします。'
                    'ピント位置・構図・ブレを確認して基準にする1枚を選んでください。',
                    style: TextStyle(
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
                  file: widget.files[index],
                  index: index,
                  selected: widget.files[index].path == _selectedPath,
                  onTap: () => setState(
                    () => _selectedPath = widget.files[index].path,
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
    required this.index,
    required this.selected,
    required this.onTap,
  });

  final RawInputFile file;
  final int index;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final metadata = file.metadata;
    final String detail = metadata == null
        ? 'メタデータ未確認'
        : '${metadata.width}×${metadata.height} · '
            '${metadata.cfaPattern.name.toUpperCase()} · '
            '${file.probe?.format.label ?? 'RAW'}';
    final bytes = file.thumbnailBytes;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
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
                    width: 72,
                    height: 54,
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
                        '${index + 1}. ${file.name}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        detail,
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
    );
  }
}

class _FocusStackIntroCard extends StatelessWidget {
  const _FocusStackIntroCard();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Row(
              children: <Widget>[
                Icon(Icons.layers_rounded, color: Color(0xFFF08A5D)),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'フォーカス合成',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              'ピント位置を変えて撮影したRAWを、手前から奥の順に追加してください。'
              '合焦位置を解析したあと、使用する写真とマーキングを確認してから深度合成します。',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: MobileStackColors.muted,
                    height: 1.5,
                  ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InputCard extends StatelessWidget {
  const _InputCard({
    required this.files,
    required this.validation,
    required this.isPicking,
    required this.onAdd,
    required this.onRemove,
    required this.onMove,
    required this.onClear,
  });

  final List<RawInputFile> files;
  final FocusStackInputValidation validation;
  final bool isPicking;
  final VoidCallback onAdd;
  final void Function(int index) onRemove;
  final void Function(int index, int delta) onMove;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Expanded(
                  child: Text(
                    '入力RAW',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (files.isNotEmpty)
                  TextButton(onPressed: onClear, child: const Text('全解除')),
                TextButton.icon(
                  onPressed: isPicking ? null : onAdd,
                  icon: isPicking
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.add_rounded),
                  label: const Text('追加'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text(
              'ピント位置が一方向に移る撮影順に並べてください。近景→遠景でも遠景→近景でも構いませんが、途中で逆方向に戻さないでください。',
              style: TextStyle(
                color: MobileStackColors.muted,
                fontSize: 12,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 12),
            if (files.isEmpty)
              const _EmptyInput()
            else
              for (int index = 0; index < files.length; index++)
                _FocusRawRow(
                  file: files[index],
                  index: index,
                  count: files.length,
                  onMoveUp: () => onMove(index, -1),
                  onMoveDown: () => onMove(index, 1),
                  onRemove: () => onRemove(index),
                ),
            const SizedBox(height: 10),
            _ValidationSummary(validation: validation),
          ],
        ),
      ),
    );
  }
}

class _EmptyInput extends StatelessWidget {
  const _EmptyInput();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 18),
      child: Column(
        children: <Widget>[
          Icon(
            Icons.add_photo_alternate_outlined,
            size: 36,
            color: MobileStackColors.muted,
          ),
          SizedBox(height: 8),
          Text(
            'RAWを2枚以上選択してください',
            style: TextStyle(color: MobileStackColors.muted),
          ),
        ],
      ),
    );
  }
}

class _FocusRawRow extends StatelessWidget {
  const _FocusRawRow({
    required this.file,
    required this.index,
    required this.count,
    required this.onMoveUp,
    required this.onMoveDown,
    required this.onRemove,
  });

  final RawInputFile file;
  final int index;
  final int count;
  final VoidCallback onMoveUp;
  final VoidCallback onMoveDown;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final metadata = file.metadata;
    final String detail = metadata == null
        ? 'メタデータ未確認'
        : '${metadata.width}×${metadata.height} · '
            '${metadata.cfaPattern.name.toUpperCase()} · '
            '${file.probe?.format.label ?? 'RAW'}';

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: MobileStackColors.surfaceHigh,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: MobileStackColors.outline),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
          child: Row(
            children: <Widget>[
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: const Color(0x29F08A5D),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${index + 1}',
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      file.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      detail,
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
              IconButton(
                tooltip: '上へ',
                onPressed: index == 0 ? null : onMoveUp,
                icon: const Icon(Icons.keyboard_arrow_up_rounded),
              ),
              IconButton(
                tooltip: '下へ',
                onPressed: index == count - 1 ? null : onMoveDown,
                icon: const Icon(Icons.keyboard_arrow_down_rounded),
              ),
              IconButton(
                tooltip: '削除',
                onPressed: onRemove,
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ValidationSummary extends StatelessWidget {
  const _ValidationSummary({required this.validation});

  final FocusStackInputValidation validation;

  @override
  Widget build(BuildContext context) {
    if (validation.inputCount < validation.minimumInputCount) {
      return Text(
        'あと${validation.minimumInputCount - validation.inputCount}枚必要です',
        style: const TextStyle(
          color: MobileStackColors.warning,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      );
    }
    if (validation.issues.isEmpty) {
      return const Row(
        children: <Widget>[
          Icon(Icons.check_circle_rounded,
              size: 18, color: MobileStackColors.success),
          SizedBox(width: 7),
          Expanded(
            child: Text(
              '入力互換性チェック：OK',
              style: TextStyle(
                color: MobileStackColors.success,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Text(
          '入力互換性チェック：要修正',
          style: TextStyle(
            color: Color(0xFFFF6B7A),
            fontSize: 12,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 5),
        for (final FocusStackInputIssue issue in validation.issues.take(4))
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Text(
              '・${issue.fileName}: ${issue.message}',
              style: const TextStyle(
                color: Color(0xFFFFA0AA),
                fontSize: 11,
              ),
            ),
          ),
      ],
    );
  }
}

// Retained for the foreground fallback UI; Android currently launches the
// equivalent options through the background-processing review flow.
// ignore: unused_element
class _FocusMarkingOptionsCard extends StatelessWidget {
  const _FocusMarkingOptionsCard({
    required this.showOmissionCandidates,
    required this.autoExcludeOmissionCandidates,
    required this.onShowChanged,
    required this.onAutoExcludeChanged,
  });

  final bool showOmissionCandidates;
  final bool autoExcludeOmissionCandidates;
  final ValueChanged<bool> onShowChanged;
  final ValueChanged<bool> onAutoExcludeChanged;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              '合焦位置の確認',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            const Text(
              '高精度解析後、各写真のピントが合っている領域を画像上へマーキングします。最終的に使用する写真はユーザーが変更できます。',
              style: TextStyle(
                color: MobileStackColors.muted,
                fontSize: 11,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 8),
            CheckboxListTile(
              value: showOmissionCandidates,
              contentPadding: EdgeInsets.zero,
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text(
                '省略可能な写真を表示',
                style: TextStyle(fontSize: 13),
              ),
              subtitle: const Text(
                '他の写真で合焦領域をカバーできる写真を候補表示します。',
                style: TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                ),
              ),
              onChanged: (bool? value) => onShowChanged(value ?? false),
            ),
            CheckboxListTile(
              value: autoExcludeOmissionCandidates,
              contentPadding: EdgeInsets.zero,
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text(
                '省略可能な写真を自動除外',
                style: TextStyle(fontSize: 13),
              ),
              subtitle: const Text(
                '有効時のみ使用OFFにします。合焦カバーを失う写真は除外せず、あとから個別にONへ戻せます。',
                style: TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                ),
              ),
              onChanged: (bool? value) => onAutoExcludeChanged(value ?? false),
            ),
          ],
        ),
      ),
    );
  }
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.validation,
    required this.busy,
    required this.onPressed,
  });

  final FocusStackInputValidation validation;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xF2070A12),
      elevation: 16,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: FilledButton.icon(
            onPressed: validation.isValid && !busy ? onPressed : null,
            icon: busy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.center_focus_strong_rounded),
            label: Text(
              busy
                  ? '処理中'
                  : validation.isValid
                      ? '合焦位置を解析'
                      : '入力RAWを確認してください',
            ),
          ),
        ),
      ),
    );
  }
}

class _FocusProgressCard extends StatelessWidget {
  const _FocusProgressCard({
    required this.fraction,
    required this.stage,
  });

  final double fraction;
  final String stage;

  @override
  Widget build(BuildContext context) {
    final double safe = fraction.clamp(0, 1).toDouble();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              stage,
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 9),
            LinearProgressIndicator(value: safe),
            const SizedBox(height: 6),
            Text(
              '${(safe * 100).toStringAsFixed(0)}%',
              style: const TextStyle(
                color: MobileStackColors.muted,
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FocusResultCard extends StatelessWidget {
  const _FocusResultCard({
    required this.result,
    required this.saving,
    required this.savedPath,
    required this.onSave,
    required this.outputFormat,
  });

  final FocusStackPipelineResult result;
  final bool saving;
  final String? savedPath;
  final VoidCallback onSave;
  final OutputImageFormat outputFormat;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(
                  Icons.check_circle_rounded,
                  color: MobileStackColors.success,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '深度合成完了：${result.width}×${result.height} '
                    'Linear camera RGB',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: saving ? null : onSave,
              icon: saving
                  ? const SizedBox.square(
                      dimension: 17,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_alt_rounded),
              label: Text(saving ? '保存中' : '${outputFormat.label}として保存'),
            ),
            if (savedPath != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                '保存先：$savedPath',
                style: const TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _QualityPolicyCard extends StatelessWidget {
  const _QualityPolicyCard();

  @override
  Widget build(BuildContext context) {
    return const Card(
      child: Padding(
        padding: EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              '入力条件',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
            ),
            SizedBox(height: 8),
            Text(
              '・2枚以上\n'
              '・同じRAW形式\n'
              '・同じ画素寸法\n'
              '・同じCFA配列\n'
              '・同じActiveArea / orientation\n'
              '・ピント位置が一方向に移る並び順',
              style: TextStyle(
                color: Color(0xFFD9E0EC),
                fontSize: 12,
                height: 1.7,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
