import 'dart:typed_data';

import '../io/raw_input_contract.dart';
import 'focus_frame_selection_policy.dart';
import 'focus_exact_preview.dart';
import 'high_precision_focus_marking.dart';

final class FocusMarkingPreviewFrame {
  FocusMarkingPreviewFrame({
    required this.input,
    required this.frameIndex,
    required this.markingWidth,
    required this.markingHeight,
    required Uint8List markingMask,
    required this.markedFraction,
    required Uint8List exactPreviewLuminance8,
    required this.exactPreviewWidth,
    required this.exactPreviewHeight,
    required this.selected,
    required this.omissionCandidate,
    required this.isReference,
  })  : markingMask = markingMask.asUnmodifiableView(),
        exactPreviewLuminance8 = exactPreviewLuminance8.asUnmodifiableView() {
    if (frameIndex < 0 ||
        markingWidth <= 0 ||
        markingHeight <= 0 ||
        this.markingMask.length != markingWidth * markingHeight ||
        exactPreviewWidth <= 0 ||
        exactPreviewHeight <= 0 ||
        this.exactPreviewLuminance8.length !=
            exactPreviewWidth * exactPreviewHeight ||
        !markedFraction.isFinite ||
        markedFraction < 0 ||
        markedFraction > 1) {
      throw ArgumentError('Invalid focus-marking preview frame.');
    }
  }

  final RawInputFile input;
  final int frameIndex;
  final int markingWidth;
  final int markingHeight;
  final Uint8List markingMask;
  final double markedFraction;
  final Uint8List exactPreviewLuminance8;
  final int exactPreviewWidth;
  final int exactPreviewHeight;
  final bool selected;
  final bool omissionCandidate;
  final bool isReference;

  FocusMarkingPreviewFrame copyWith({
    bool? selected,
  }) =>
      FocusMarkingPreviewFrame(
        input: input,
        frameIndex: frameIndex,
        markingWidth: markingWidth,
        markingHeight: markingHeight,
        markingMask: markingMask,
        markedFraction: markedFraction,
        exactPreviewLuminance8: exactPreviewLuminance8,
        exactPreviewWidth: exactPreviewWidth,
        exactPreviewHeight: exactPreviewHeight,
        selected: selected ?? this.selected,
        omissionCandidate: omissionCandidate,
        isReference: isReference,
      );
}

final class FocusMarkingPreviewModel {
  FocusMarkingPreviewModel({
    required List<FocusMarkingPreviewFrame> frames,
  }) : frames = List<FocusMarkingPreviewFrame>.unmodifiable(frames) {
    if (this.frames.length < 2) {
      throw ArgumentError(
          'Focus marking preview requires at least two frames.');
    }
  }

  final List<FocusMarkingPreviewFrame> frames;

  int get selectedCount => frames.where((f) => f.selected).length;

  List<RawInputFile> get selectedInputs => <RawInputFile>[
        for (final FocusMarkingPreviewFrame frame in frames)
          if (frame.selected) frame.input,
      ];

  FocusMarkingPreviewModel withFrameSelection(int frameIndex, bool selected) {
    if (frameIndex < 0 || frameIndex >= frames.length) {
      throw RangeError.index(frameIndex, frames);
    }
    if (frames[frameIndex].isReference && !selected) {
      return this;
    }
    final List<FocusMarkingPreviewFrame> updated =
        List<FocusMarkingPreviewFrame>.from(frames);
    updated[frameIndex] = updated[frameIndex].copyWith(selected: selected);

    if (updated.where((f) => f.selected).length < 2) {
      return this;
    }
    return FocusMarkingPreviewModel(frames: updated);
  }
}

FocusMarkingPreviewModel buildFocusMarkingPreviewModel({
  required List<RawInputFile> inputs,
  required HighPrecisionFocusMarking marking,
  required List<FocusExactPreview> exactPreviews,
  required bool autoExclude,
  required int referenceFrameIndex,
  List<bool>? initialSelection,
  List<bool>? omissionCandidates,
}) {
  if (inputs.length != marking.frameCount ||
      exactPreviews.length != marking.frameCount ||
      referenceFrameIndex < 0 ||
      referenceFrameIndex >= inputs.length) {
    throw ArgumentError(
      'Preview input/exact-preview count must match focus marking.',
    );
  }
  if ((initialSelection == null) != (omissionCandidates == null) ||
      (initialSelection != null &&
          (initialSelection.length != marking.frameCount ||
              omissionCandidates!.length != marking.frameCount))) {
    throw ArgumentError('Precomputed focus selection lengths do not match.');
  }
  final FocusFrameSelectionState state = initialSelection == null
      ? applyOptionalAutoExclusion(
          marking: marking,
          autoExclude: autoExclude,
        )
      : FocusFrameSelectionState(
          selected: initialSelection,
          omissionCandidates: omissionCandidates!,
        );
  final List<bool> selected = List<bool>.from(state.selected);
  selected[referenceFrameIndex] = true;
  return FocusMarkingPreviewModel(
    frames: <FocusMarkingPreviewFrame>[
      for (int i = 0; i < inputs.length; i++)
        FocusMarkingPreviewFrame(
          input: inputs[i],
          frameIndex: i,
          markingWidth: marking.width,
          markingHeight: marking.height,
          markingMask: marking.frameMasks[i],
          markedFraction: marking.coverageFractions[i],
          exactPreviewLuminance8: exactPreviews[i].luminance8,
          exactPreviewWidth: exactPreviews[i].width,
          exactPreviewHeight: exactPreviews[i].height,
          selected: selected[i],
          omissionCandidate: state.omissionCandidates[i],
          isReference: i == referenceFrameIndex,
        ),
    ],
  );
}
