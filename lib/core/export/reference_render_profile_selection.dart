import 'dng_final_render_profile.dart';

/// Selects the successful render profile with the lowest original frame index.
///
/// The list is indexed by source-frame index. Job completion order therefore
/// cannot change which frame becomes the final-render reference.
DngFinalRenderProfile? selectLowestIndexRenderProfile(
  List<DngFinalRenderProfile?> profiles,
) {
  for (final DngFinalRenderProfile? profile in profiles) {
    if (profile != null) return profile;
  }
  return null;
}

/// Validates the shipping all-success workflow and returns its deterministic
/// reference render profile.
///
/// Once all validation jobs have succeeded, every source frame must have
/// produced exactly one atomic render profile at the same original frame
/// index. Silently exporting with a missing profile would bypass camera color
/// conversion/profile rendering, while accepting a mismatched [sourceId]
/// could combine metadata from a different RAW with the stored pixels.
/// Therefore this helper deliberately fails closed instead of falling back to
/// an unprofiled export.
DngFinalRenderProfile requireAlignedReferenceRenderProfile({
  required List<DngFinalRenderProfile?> profiles,
  required List<String> sourcePaths,
  required int referenceIndex,
}) {
  if (profiles.length != sourcePaths.length) {
    throw StateError(
      'Render-profile/source count mismatch: ${profiles.length} profiles for '
      '${sourcePaths.length} source frames.',
    );
  }
  if (sourcePaths.isEmpty) {
    throw StateError('At least one source frame is required for final export.');
  }
  if (referenceIndex < 0 || referenceIndex >= sourcePaths.length) {
    throw RangeError.range(
      referenceIndex,
      0,
      sourcePaths.length - 1,
      'referenceIndex',
    );
  }

  for (int index = 0; index < sourcePaths.length; index++) {
    final DngFinalRenderProfile? profile = profiles[index];
    if (profile == null) {
      throw StateError(
        'Missing final-render profile for successful source frame $index.',
      );
    }
    if (profile.sourceId != sourcePaths[index]) {
      throw StateError('Final-render profile/source mismatch at frame $index.');
    }
  }

  return profiles[referenceIndex]!;
}
