import '../registration/luminance_plane.dart';
import 'focus_alignment_estimator.dart';
import 'focus_feature_detector.dart';
import 'focus_feature_matcher.dart';

final class FocusCorrespondenceResult {
  const FocusCorrespondenceResult({
    required this.referenceFeatures,
    required this.sourceFeatures,
    required this.matches,
    required this.alignment,
  });

  final List<FocusFeaturePoint> referenceFeatures;
  final List<FocusFeaturePoint> sourceFeatures;
  final List<FocusFeatureMatch> matches;
  final FocusAlignmentEstimate alignment;
}

/// Detect -> patch-match -> robust scaled-similarity fit.
FocusCorrespondenceResult estimateFocusAlignmentFromLuminance({
  required LuminancePlane reference,
  required LuminancePlane source,
  int maximumFeatures = 256,
  int minimumInliers = 3,
}) {
  final List<FocusFeaturePoint> referenceFeatures = detectFocusFeatures(
    reference,
    maximumFeatures: maximumFeatures,
  );
  final List<FocusFeaturePoint> sourceFeatures = detectFocusFeatures(
    source,
    maximumFeatures: maximumFeatures,
  );
  final List<FocusFeatureMatch> matches = matchFocusFeatures(
    referenceLuminance: reference,
    sourceLuminance: source,
    referenceFeatures: referenceFeatures,
    sourceFeatures: sourceFeatures,
  );
  if (matches.length < minimumInliers) {
    throw const FocusAlignmentFailed(
      'Not enough reliable focus-feature matches.',
    );
  }

  final FocusAlignmentEstimate alignment = estimateFocusAlignment(
    <FocusAlignmentMatch>[
      for (final FocusFeatureMatch match in matches) match.toAlignmentMatch(),
    ],
    minimumInliers: minimumInliers,
  );
  return FocusCorrespondenceResult(
    referenceFeatures: referenceFeatures,
    sourceFeatures: sourceFeatures,
    matches: matches,
    alignment: alignment,
  );
}
