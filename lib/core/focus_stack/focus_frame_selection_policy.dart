import 'high_precision_focus_marking.dart';

final class FocusFrameSelectionState {
  FocusFrameSelectionState({
    required List<bool> selected,
    required List<bool> omissionCandidates,
  })  : selected = List<bool>.unmodifiable(selected),
        omissionCandidates = List<bool>.unmodifiable(omissionCandidates) {
    if (this.selected.length != this.omissionCandidates.length) {
      throw ArgumentError('Focus-frame selection lengths must match.');
    }
  }

  final List<bool> selected;
  final List<bool> omissionCandidates;
}

List<bool> findOmissionCandidates(
  HighPrecisionFocusMarking marking, {
  double requiredOtherCoverage = 1.0,
}) {
  if (!requiredOtherCoverage.isFinite ||
      requiredOtherCoverage <= 0 ||
      requiredOtherCoverage > 1) {
    throw ArgumentError.value(requiredOtherCoverage, 'requiredOtherCoverage');
  }
  final int pixels = marking.width * marking.height;
  final List<bool> result = List<bool>.filled(marking.frameCount, false);

  for (int frame = 0; frame < marking.frameCount; frame++) {
    int own = 0;
    int coveredByOthers = 0;
    for (int pixel = 0; pixel < pixels; pixel++) {
      if (marking.frameMasks[frame][pixel] == 0) continue;
      own++;
      bool covered = false;
      for (int other = 0; other < marking.frameCount; other++) {
        if (other == frame) continue;
        if (marking.frameMasks[other][pixel] != 0) {
          covered = true;
          break;
        }
      }
      if (covered) coveredByOthers++;
    }
    result[frame] = own == 0 || coveredByOthers / own >= requiredOtherCoverage;
  }
  return List<bool>.unmodifiable(result);
}

FocusFrameSelectionState applyOptionalAutoExclusion({
  required HighPrecisionFocusMarking marking,
  required bool autoExclude,
  List<bool>? initialSelection,
}) {
  final List<bool> selected = initialSelection == null
      ? List<bool>.filled(marking.frameCount, true)
      : List<bool>.from(initialSelection);
  if (selected.length != marking.frameCount) {
    throw ArgumentError('Initial focus-frame selection length mismatch.');
  }
  final List<bool> candidates = findOmissionCandidates(marking);
  if (!autoExclude) {
    return FocusFrameSelectionState(
      selected: selected,
      omissionCandidates: candidates,
    );
  }

  for (int frame = 0; frame < marking.frameCount; frame++) {
    if (!selected[frame] || !candidates[frame]) continue;
    final int selectedCount = selected.where((bool value) => value).length;
    if (selectedCount <= 2) break;
    selected[frame] = false;
    if (!_allMarkedPixelsStillCovered(marking, selected)) {
      selected[frame] = true;
    }
  }
  return FocusFrameSelectionState(
    selected: selected,
    omissionCandidates: candidates,
  );
}

bool _allMarkedPixelsStillCovered(
  HighPrecisionFocusMarking marking,
  List<bool> selected,
) {
  final int pixels = marking.width * marking.height;
  for (int pixel = 0; pixel < pixels; pixel++) {
    bool originallyMarked = false;
    bool covered = false;
    for (int frame = 0; frame < marking.frameCount; frame++) {
      if (marking.frameMasks[frame][pixel] == 0) continue;
      originallyMarked = true;
      if (selected[frame]) covered = true;
    }
    if (originallyMarked && !covered) return false;
  }
  return true;
}
