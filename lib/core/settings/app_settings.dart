import 'package:shared_preferences/shared_preferences.dart';

import '../export/output_image_format.dart';
import '../export/lightroom_storage_preset.dart';
import '../quality/processing_quality_level.dart';
import '../stacking/star_trail_edge_fade.dart';
import '../stacking/star_trail_gap_fill.dart';

/// Persisted user-facing application settings.
final class AppSettings {
  AppSettings._();

  static final SharedPreferencesAsync _preferences = SharedPreferencesAsync();
  static const String _outputFormatKey = 'default_output_format_v1';
  static const String _qualityLevelKey = 'processing_quality_level_v1';
  static const String _storagePresetKey = 'lightroom_storage_preset_v1';
  static const String _automaticMovingObjectRemovalKey =
      'automatic_moving_object_removal_v1';
  static const String _automaticStarTrailAircraftRemovalKey =
      'automatic_star_trail_aircraft_removal_v1';
  static const String _automaticStarTrailForegroundProtectionKey =
      'automatic_star_trail_foreground_protection_v1';
  static const String _starTrailGapFillModeKey = 'star_trail_gap_fill_mode_v1';
  static const String _starTrailFadeModeKey = 'star_trail_fade_mode_v1';
  static const String _starTrailFadeCurveKey = 'star_trail_fade_curve_v1';
  static const String _starTrailFadeLengthFractionKey =
      'star_trail_fade_length_fraction_v1';
  static const String _starTrailFadeMinWeightKey =
      'star_trail_fade_min_weight_v1';
  static const String _wholeFieldRegistrationKey =
      'milky_way_whole_field_registration_v1';
  static const String _focusExposureNormalizationKey =
      'focus_exposure_normalization_v1';
  static const String _focusPyramidBlendKey = 'focus_pyramid_blend_v1';
  static const String _starTrailHotPixelRemovalKey =
      'star_trail_hot_pixel_removal_v1';
  static const String _starTrailMeteorProtectionKey =
      'star_trail_meteor_protection_v1';
  static const String _starTrailMeanBackgroundKey =
      'star_trail_mean_background_v1';
  static const String _starTrailForegroundAverageKey =
      'star_trail_foreground_average_v1';
  static const String _meteorAdditiveCompositeKey =
      'meteor_additive_composite_v1';

  static const OutputImageFormat defaultOutputFormat =
      OutputImageFormat.linearDng;
  static const ProcessingQualityLevel defaultQualityLevel =
      ProcessingQualityLevel.maximum;
  static const LightroomStoragePreset defaultStoragePreset =
      LightroomStoragePreset.maximum;
  static const bool defaultAutomaticMovingObjectRemoval = true;

  /// Work351: guided whole-field (homography) registration for Milky Way.
  /// Opt-in until validated on device data; OFF keeps Work350 output
  /// bit-identical.
  static const bool defaultWholeFieldRegistration = false;

  /// Work353: focus-stack brightness/colour normalization (opt-in; OFF keeps
  /// the blend bit-identical).
  static const bool defaultFocusExposureNormalization = false;

  /// Work354: focus-stack multi-band (pyramid) blending (opt-in; OFF keeps
  /// the depth-map blend bit-identical).
  static const bool defaultFocusPyramidBlend = false;

  /// Work355: star-trail stationary hot-pixel removal (opt-in; OFF keeps the
  /// comparison-light result bit-identical).
  static const bool defaultStarTrailHotPixelRemoval = false;

  /// Work356 star-trail options (opt-in; OFF keeps the result bit-identical).
  static const bool defaultStarTrailMeteorProtection = false;
  static const bool defaultStarTrailMeanBackground = false;
  static const bool defaultStarTrailForegroundAverage = false;

  /// Work357: meteor additive compositing (opt-in; OFF keeps lighten).
  static const bool defaultMeteorAdditiveComposite = false;
  static const bool defaultAutomaticStarTrailAircraftRemoval = true;
  // Conservative opt-in until validated on representative real star-trail
  // sequences. The algorithm is designed to suppress broad transient
  // brightening without touching thin stellar trails.
  static const bool defaultAutomaticStarTrailForegroundProtection = false;
  // Off by default: this is new, unverified (no Flutter/Dart SDK in the
  // environment that wrote it — see star_trail_gap_fill.dart), and adds
  // per-frame star-detection cost to a mode that was previously the
  // cheapest one in the app. Opt-in until confirmed on a real device.
  static const StarTrailGapFillMode defaultStarTrailGapFillMode =
      StarTrailGapFillMode.off;
  // Off by default for the same reason as gap fill: new and unverified on
  // real device hardware in this environment (no Flutter/Dart SDK — see
  // star_trail_edge_fade.dart). It only changes blend weighting, never
  // resolution/bit depth, but still opt-in until confirmed on-device.
  static const StarTrailFadeMode defaultStarTrailFadeMode =
      StarTrailFadeMode.off;
  static const StarTrailFadeCurve defaultStarTrailFadeCurve =
      StarTrailFadeCurve.ease;
  static const double defaultStarTrailFadeLengthFraction = 0.1;
  static const double defaultStarTrailFadeMinWeight = 0.0;

  static Future<OutputImageFormat> loadOutputFormat() async {
    final String? stored = await _preferences.getString(_outputFormatKey);
    if (stored == null) return defaultOutputFormat;
    return selectableOutputFormats.firstWhere(
      (OutputImageFormat value) => value.name == stored,
      orElse: () => defaultOutputFormat,
    );
  }

  static Future<void> saveOutputFormat(OutputImageFormat value) async {
    if (!selectableOutputFormats.contains(value)) {
      throw ArgumentError.value(value, 'value', 'Unsupported output setting.');
    }
    await _preferences.setString(_outputFormatKey, value.name);
  }

  static Future<ProcessingQualityLevel> loadQualityLevel() async {
    final String? stored = await _preferences.getString(_qualityLevelKey);
    return ProcessingQualityLevel.values.firstWhere(
      (ProcessingQualityLevel value) => value.name == stored,
      orElse: () => defaultQualityLevel,
    );
  }

  static Future<void> saveQualityLevel(ProcessingQualityLevel value) =>
      _preferences.setString(_qualityLevelKey, value.name);

  static Future<LightroomStoragePreset> loadStoragePreset() async {
    final String? stored = await _preferences.getString(_storagePresetKey);
    return LightroomStoragePreset.values.firstWhere(
      (LightroomStoragePreset value) => value.name == stored,
      orElse: () => defaultStoragePreset,
    );
  }

  static Future<bool> loadAutomaticMovingObjectRemoval() async =>
      await _preferences.getBool(_automaticMovingObjectRemovalKey) ??
      defaultAutomaticMovingObjectRemoval;

  static Future<void> saveAutomaticMovingObjectRemoval(bool value) =>
      _preferences.setBool(_automaticMovingObjectRemovalKey, value);

  static Future<bool> loadWholeFieldRegistration() async =>
      await _preferences.getBool(_wholeFieldRegistrationKey) ??
      defaultWholeFieldRegistration;

  static Future<void> saveWholeFieldRegistration(bool value) =>
      _preferences.setBool(_wholeFieldRegistrationKey, value);

  static Future<bool> loadFocusExposureNormalization() async =>
      await _preferences.getBool(_focusExposureNormalizationKey) ??
      defaultFocusExposureNormalization;

  static Future<void> saveFocusExposureNormalization(bool value) =>
      _preferences.setBool(_focusExposureNormalizationKey, value);

  static Future<bool> loadFocusPyramidBlend() async =>
      await _preferences.getBool(_focusPyramidBlendKey) ??
      defaultFocusPyramidBlend;

  static Future<void> saveFocusPyramidBlend(bool value) =>
      _preferences.setBool(_focusPyramidBlendKey, value);

  static Future<bool> loadStarTrailHotPixelRemoval() async =>
      await _preferences.getBool(_starTrailHotPixelRemovalKey) ??
      defaultStarTrailHotPixelRemoval;

  static Future<void> saveStarTrailHotPixelRemoval(bool value) =>
      _preferences.setBool(_starTrailHotPixelRemovalKey, value);

  static Future<bool> loadStarTrailMeteorProtection() async =>
      await _preferences.getBool(_starTrailMeteorProtectionKey) ??
      defaultStarTrailMeteorProtection;

  static Future<void> saveStarTrailMeteorProtection(bool value) =>
      _preferences.setBool(_starTrailMeteorProtectionKey, value);

  static Future<bool> loadStarTrailMeanBackground() async =>
      await _preferences.getBool(_starTrailMeanBackgroundKey) ??
      defaultStarTrailMeanBackground;

  static Future<void> saveStarTrailMeanBackground(bool value) =>
      _preferences.setBool(_starTrailMeanBackgroundKey, value);

  static Future<bool> loadStarTrailForegroundAverage() async =>
      await _preferences.getBool(_starTrailForegroundAverageKey) ??
      defaultStarTrailForegroundAverage;

  static Future<void> saveStarTrailForegroundAverage(bool value) =>
      _preferences.setBool(_starTrailForegroundAverageKey, value);

  static Future<bool> loadMeteorAdditiveComposite() async =>
      await _preferences.getBool(_meteorAdditiveCompositeKey) ??
      defaultMeteorAdditiveComposite;

  static Future<void> saveMeteorAdditiveComposite(bool value) =>
      _preferences.setBool(_meteorAdditiveCompositeKey, value);

  static Future<bool> loadAutomaticStarTrailAircraftRemoval() async =>
      await _preferences.getBool(_automaticStarTrailAircraftRemovalKey) ??
      defaultAutomaticStarTrailAircraftRemoval;

  static Future<void> saveAutomaticStarTrailAircraftRemoval(bool value) =>
      _preferences.setBool(_automaticStarTrailAircraftRemovalKey, value);

  static Future<bool> loadAutomaticStarTrailForegroundProtection() async =>
      await _preferences.getBool(_automaticStarTrailForegroundProtectionKey) ??
      defaultAutomaticStarTrailForegroundProtection;

  static Future<void> saveAutomaticStarTrailForegroundProtection(bool value) =>
      _preferences.setBool(_automaticStarTrailForegroundProtectionKey, value);

  static Future<StarTrailGapFillMode> loadStarTrailGapFillMode() async {
    final String? stored =
        await _preferences.getString(_starTrailGapFillModeKey);
    return StarTrailGapFillMode.values.firstWhere(
      (StarTrailGapFillMode value) => value.name == stored,
      orElse: () => defaultStarTrailGapFillMode,
    );
  }

  static Future<void> saveStarTrailGapFillMode(
    StarTrailGapFillMode value,
  ) =>
      _preferences.setString(_starTrailGapFillModeKey, value.name);

  static Future<StarTrailFadeMode> loadStarTrailFadeMode() async {
    final String? stored = await _preferences.getString(_starTrailFadeModeKey);
    return StarTrailFadeMode.values.firstWhere(
      (StarTrailFadeMode value) => value.name == stored,
      orElse: () => defaultStarTrailFadeMode,
    );
  }

  static Future<void> saveStarTrailFadeMode(StarTrailFadeMode value) =>
      _preferences.setString(_starTrailFadeModeKey, value.name);

  static Future<StarTrailFadeCurve> loadStarTrailFadeCurve() async {
    final String? stored = await _preferences.getString(_starTrailFadeCurveKey);
    return StarTrailFadeCurve.values.firstWhere(
      (StarTrailFadeCurve value) => value.name == stored,
      orElse: () => defaultStarTrailFadeCurve,
    );
  }

  static Future<void> saveStarTrailFadeCurve(StarTrailFadeCurve value) =>
      _preferences.setString(_starTrailFadeCurveKey, value.name);

  static Future<double> loadStarTrailFadeLengthFraction() async =>
      await _preferences.getDouble(_starTrailFadeLengthFractionKey) ??
      defaultStarTrailFadeLengthFraction;

  static Future<void> saveStarTrailFadeLengthFraction(double value) =>
      _preferences.setDouble(_starTrailFadeLengthFractionKey, value);

  static Future<double> loadStarTrailFadeMinWeight() async =>
      await _preferences.getDouble(_starTrailFadeMinWeightKey) ??
      defaultStarTrailFadeMinWeight;

  static Future<void> saveStarTrailFadeMinWeight(double value) =>
      _preferences.setDouble(_starTrailFadeMinWeightKey, value);

  static Future<void> saveStoragePreset(LightroomStoragePreset value) async {
    await _preferences.setString(_storagePresetKey, value.name);
    await saveOutputFormat(value.outputFormat);
  }
}

/// BMP remains an internal compatibility format and is deliberately not shown
/// in Settings or the normal RAW workflow.
const List<OutputImageFormat> selectableOutputFormats = <OutputImageFormat>[
  OutputImageFormat.jpeg,
  OutputImageFormat.tiff16,
  OutputImageFormat.linearDng,
];
