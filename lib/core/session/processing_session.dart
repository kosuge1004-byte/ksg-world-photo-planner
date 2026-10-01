import 'package:flutter/foundation.dart';
import '../stacking/foreground_region.dart';

import '../io/raw_input_contract.dart';
import '../export/output_image_format.dart';
import '../export/lightroom_storage_preset.dart';
import '../quality/processing_quality_level.dart';
import '../models/processing_mode.dart';
import '../diagnostics/processing_failure_report.dart';
import '../stacking/star_trail_edge_fade.dart';
import '../stacking/star_trail_gap_fill.dart';

enum SessionStatus { empty, ready, processing, completed, cancelled, failed }

class ProcessingSession extends ChangeNotifier {
  ProcessingSession({
    required this.mode,
    OutputImageFormat outputFormat = OutputImageFormat.linearDng,
    ProcessingQualityLevel qualityLevel = ProcessingQualityLevel.maximum,
    LightroomStoragePreset storagePreset = LightroomStoragePreset.maximum,
    bool automaticMovingObjectRemoval = true,
    bool automaticStarTrailAircraftRemoval = true,
    bool automaticStarTrailForegroundProtection = false,
    StarTrailGapFillMode starTrailGapFillMode = StarTrailGapFillMode.off,
    StarTrailFadeMode starTrailFadeMode = StarTrailFadeMode.off,
    StarTrailFadeCurve starTrailFadeCurve = StarTrailFadeCurve.ease,
    double starTrailFadeLengthFraction = 0.1,
    double starTrailFadeMinWeight = 0.0,
    bool wholeFieldRegistration = false,
    bool starTrailHotPixelRemoval = false,
    bool starTrailMeteorProtection = false,
    bool starTrailMeanBackground = false,
    bool starTrailForegroundAverage = false,
  })  : _wholeFieldRegistration = wholeFieldRegistration,
        _starTrailHotPixelRemoval = starTrailHotPixelRemoval,
        _starTrailMeteorProtection = starTrailMeteorProtection,
        _starTrailMeanBackground = starTrailMeanBackground,
        _starTrailForegroundAverage = starTrailForegroundAverage,
        _outputFormat = outputFormat,
        _qualityLevel = qualityLevel,
        _storagePreset = storagePreset,
        _automaticMovingObjectRemoval = automaticMovingObjectRemoval,
        _automaticStarTrailAircraftRemoval = automaticStarTrailAircraftRemoval,
        _automaticStarTrailForegroundProtection =
            automaticStarTrailForegroundProtection,
        _starTrailGapFillMode = starTrailGapFillMode,
        _starTrailFadeMode = starTrailFadeMode,
        _starTrailFadeCurve = starTrailFadeCurve,
        _starTrailFadeLengthFraction = starTrailFadeLengthFraction,
        _starTrailFadeMinWeight = starTrailFadeMinWeight;

  final ProcessingMode mode;
  final List<RawInputFile> _files = <RawInputFile>[];

  SessionStatus _status = SessionStatus.empty;
  double _progress = 0;
  Object? _error;
  StackTrace? _errorStackTrace;
  ProcessingFailureReport? _failureReport;
  OutputImageFormat _outputFormat;
  ProcessingQualityLevel _qualityLevel;
  LightroomStoragePreset _storagePreset;
  bool _automaticMovingObjectRemoval;
  bool _wholeFieldRegistration;
  bool _starTrailHotPixelRemoval;
  bool _starTrailMeteorProtection;
  bool _starTrailMeanBackground;
  bool _starTrailForegroundAverage;
  bool _automaticStarTrailAircraftRemoval;
  bool _automaticStarTrailForegroundProtection;
  StarTrailGapFillMode _starTrailGapFillMode;
  StarTrailFadeMode _starTrailFadeMode;
  StarTrailFadeCurve _starTrailFadeCurve;
  double _starTrailFadeLengthFraction;
  double _starTrailFadeMinWeight;
  String? _referencePath;
  ForegroundRegion? _foregroundRegion;
  bool _starTrailPureMaxReference = false;
  bool get starTrailPureMaxReference => _starTrailPureMaxReference;
  void setStarTrailPureMaxReference(bool value) {
    if (_status == SessionStatus.processing ||
        mode != ProcessingMode.starTrail) {
      return;
    }
    _starTrailPureMaxReference = value;
    notifyListeners();
  }

  ForegroundRegion? get foregroundRegion => _foregroundRegion;
  void setForegroundRegion(ForegroundRegion? value) {
    if (_status == SessionStatus.processing) return;
    _foregroundRegion = value;
    notifyListeners();
  }

  List<RawInputFile> get files => List<RawInputFile>.unmodifiable(_files);
  SessionStatus get status => _status;
  double get progress => _progress;
  Object? get error => _error;
  StackTrace? get errorStackTrace => _errorStackTrace;
  ProcessingFailureReport? get failureReport => _failureReport;
  OutputImageFormat get outputFormat => _outputFormat;
  ProcessingQualityLevel get qualityLevel => _qualityLevel;
  LightroomStoragePreset get storagePreset => _storagePreset;
  bool get automaticMovingObjectRemoval => _automaticMovingObjectRemoval;
  bool get automaticStarTrailAircraftRemoval =>
      _automaticStarTrailAircraftRemoval;
  bool get automaticStarTrailForegroundProtection =>
      _automaticStarTrailForegroundProtection;
  StarTrailGapFillMode get starTrailGapFillMode => _starTrailGapFillMode;
  StarTrailFadeMode get starTrailFadeMode => _starTrailFadeMode;
  StarTrailFadeCurve get starTrailFadeCurve => _starTrailFadeCurve;
  double get starTrailFadeLengthFraction => _starTrailFadeLengthFraction;
  double get starTrailFadeMinWeight => _starTrailFadeMinWeight;
  String? get referencePath => _referencePath;
  int? get referenceIndex {
    final String? path = _referencePath;
    if (path == null) return null;
    final int index = _files.indexWhere(
      (RawInputFile file) => file.path == path,
    );
    return index < 0 ? null : index;
  }

  int get totalBytes => _files.fold<int>(
        0,
        (int value, RawInputFile file) => value + file.byteLength,
      );
  bool get canStart =>
      _files.length >= mode.minimumInputCount &&
      _status != SessionStatus.processing;

  void setOutputFormat(OutputImageFormat value) {
    if (_status == SessionStatus.processing || value == _outputFormat) return;
    _outputFormat = value;
    if (value == OutputImageFormat.linearDng) {
      if (_storagePreset.outputFormat != OutputImageFormat.linearDng) {
        _storagePreset = LightroomStoragePreset.maximum;
      }
    } else {
      for (final LightroomStoragePreset preset
          in LightroomStoragePreset.values) {
        if (preset.outputFormat == value) {
          _storagePreset = preset;
          break;
        }
      }
    }
    notifyListeners();
  }

  void setQualityLevel(ProcessingQualityLevel value) {
    if (_status == SessionStatus.processing || value == _qualityLevel) return;
    _qualityLevel = value;
    notifyListeners();
  }

  /// Work351: Milky Way guided whole-field registration (opt-in).
  bool get wholeFieldRegistration => _wholeFieldRegistration;

  void setWholeFieldRegistration(bool value) {
    if (_status == SessionStatus.processing ||
        value == _wholeFieldRegistration) {
      return;
    }
    _wholeFieldRegistration = value;
    notifyListeners();
  }

  void setAutomaticMovingObjectRemoval(bool value) {
    if (_status == SessionStatus.processing ||
        value == _automaticMovingObjectRemoval) {
      return;
    }
    _automaticMovingObjectRemoval = value;
    notifyListeners();
  }

  /// Work355: star-trail stationary hot-pixel removal (opt-in).
  bool get starTrailHotPixelRemoval => _starTrailHotPixelRemoval;

  void setStarTrailHotPixelRemoval(bool value) {
    if (_status == SessionStatus.processing ||
        value == _starTrailHotPixelRemoval) {
      return;
    }
    _starTrailHotPixelRemoval = value;
    notifyListeners();
  }

  /// Work356 star-trail options (opt-in).
  bool get starTrailMeteorProtection => _starTrailMeteorProtection;
  bool get starTrailMeanBackground => _starTrailMeanBackground;
  bool get starTrailForegroundAverage => _starTrailForegroundAverage;

  void setStarTrailMeteorProtection(bool value) {
    if (_status == SessionStatus.processing ||
        value == _starTrailMeteorProtection) {
      return;
    }
    _starTrailMeteorProtection = value;
    notifyListeners();
  }

  void setStarTrailMeanBackground(bool value) {
    if (_status == SessionStatus.processing ||
        value == _starTrailMeanBackground) {
      return;
    }
    _starTrailMeanBackground = value;
    notifyListeners();
  }

  void setStarTrailForegroundAverage(bool value) {
    if (_status == SessionStatus.processing ||
        value == _starTrailForegroundAverage) {
      return;
    }
    _starTrailForegroundAverage = value;
    notifyListeners();
  }

  void setAutomaticStarTrailAircraftRemoval(bool value) {
    if (_status == SessionStatus.processing ||
        value == _automaticStarTrailAircraftRemoval) {
      return;
    }
    _automaticStarTrailAircraftRemoval = value;
    notifyListeners();
  }

  void setAutomaticStarTrailForegroundProtection(bool value) {
    if (_status == SessionStatus.processing ||
        value == _automaticStarTrailForegroundProtection) {
      return;
    }
    _automaticStarTrailForegroundProtection = value;
    notifyListeners();
  }

  void setStarTrailGapFillMode(StarTrailGapFillMode value) {
    if (_status == SessionStatus.processing || value == _starTrailGapFillMode) {
      return;
    }
    _starTrailGapFillMode = value;
    notifyListeners();
  }

  void setStarTrailFadeMode(StarTrailFadeMode value) {
    if (_status == SessionStatus.processing || value == _starTrailFadeMode) {
      return;
    }
    _starTrailFadeMode = value;
    notifyListeners();
  }

  void setStarTrailFadeCurve(StarTrailFadeCurve value) {
    if (_status == SessionStatus.processing || value == _starTrailFadeCurve) {
      return;
    }
    _starTrailFadeCurve = value;
    notifyListeners();
  }

  void setStarTrailFadeLengthFraction(double value) {
    final double clamped = value.clamp(0.0, 0.5);
    if (_status == SessionStatus.processing ||
        clamped == _starTrailFadeLengthFraction) {
      return;
    }
    _starTrailFadeLengthFraction = clamped;
    notifyListeners();
  }

  void setStarTrailFadeMinWeight(double value) {
    final double clamped = value.clamp(0.0, 1.0);
    if (_status == SessionStatus.processing ||
        clamped == _starTrailFadeMinWeight) {
      return;
    }
    _starTrailFadeMinWeight = clamped;
    notifyListeners();
  }

  /// Convenience bundle of the four fade fields above, matching the shape
  /// [computeStarTrailFadeWeights] expects.
  StarTrailFadeSettings get starTrailFadeSettings => StarTrailFadeSettings(
        mode: _starTrailFadeMode,
        curve: _starTrailFadeCurve,
        fadeLengthFraction: _starTrailFadeLengthFraction,
        minWeight: _starTrailFadeMinWeight,
      );

  void setStoragePreset(LightroomStoragePreset value) {
    if (_status == SessionStatus.processing || value == _storagePreset) return;
    _storagePreset = value;
    _outputFormat = value.outputFormat;
    notifyListeners();
  }

  void addFiles(Iterable<RawInputFile> files) {
    final Set<String> existingPaths =
        _files.map((RawInputFile file) => file.path).toSet();
    for (final RawInputFile file in files) {
      if (existingPaths.add(file.path)) _files.add(file);
    }
    _resetResultState();
    _status = _files.isEmpty ? SessionStatus.empty : SessionStatus.ready;
    notifyListeners();
  }

  void removeFile(String path) {
    _files.removeWhere((RawInputFile file) => file.path == path);
    if (_referencePath == path) {
      _referencePath = null;
      _foregroundRegion = null;
    }
    _resetResultState();
    _status = _files.isEmpty ? SessionStatus.empty : SessionStatus.ready;
    notifyListeners();
  }

  void clearFiles() {
    _files.clear();
    _foregroundRegion = null;
    _referencePath = null;
    _resetResultState();
    _status = SessionStatus.empty;
    notifyListeners();
  }

  void moveFile(int oldIndex, int newIndex) {
    if (_status == SessionStatus.processing || oldIndex == newIndex) return;
    RangeError.checkValidIndex(oldIndex, _files, 'oldIndex');
    if (newIndex < 0 || newIndex >= _files.length) {
      throw RangeError.range(newIndex, 0, _files.length - 1, 'newIndex');
    }
    final RawInputFile file = _files.removeAt(oldIndex);
    _files.insert(newIndex, file);
    _resetResultState();
    _status = SessionStatus.ready;
    notifyListeners();
  }

  /// Stores the reference as a stable source identity. The current array
  /// index is deliberately resolved only when processing starts.
  void setReferencePath(String? path) {
    if (_status == SessionStatus.processing) return;
    if (path != null && !_files.any((RawInputFile file) => file.path == path)) {
      throw ArgumentError.value(path, 'path', 'Reference RAW is not selected.');
    }
    if (_referencePath == path) return;
    if (_referencePath != path) _foregroundRegion = null;
    _referencePath = path;
    notifyListeners();
  }

  void markProcessing() {
    if (_files.isEmpty) throw StateError('RAWファイルが選択されていません。');
    _error = null;
    _errorStackTrace = null;
    _failureReport = null;
    _progress = 0;
    _status = SessionStatus.processing;
    notifyListeners();
  }

  void updateProgress(double value) {
    _progress = value.clamp(0, 1);
    notifyListeners();
  }

  void markCompleted() {
    _progress = 1;
    _status = SessionStatus.completed;
    notifyListeners();
  }

  void markCancelled() {
    _status = SessionStatus.cancelled;
    notifyListeners();
  }

  void markFailed(
    Object error, {
    StackTrace? stackTrace,
    ProcessingFailureReport? report,
  }) {
    _error = error;
    _errorStackTrace = stackTrace;
    _failureReport = report;
    _status = SessionStatus.failed;
    notifyListeners();
  }

  void resetToReady() {
    _resetResultState();
    _status = _files.isEmpty ? SessionStatus.empty : SessionStatus.ready;
    notifyListeners();
  }

  void _resetResultState() {
    _progress = 0;
    _error = null;
    _errorStackTrace = null;
    _failureReport = null;
  }
}
