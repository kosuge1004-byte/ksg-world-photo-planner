import '../io/raw_input_contract.dart';

final class FocusStackInputIssue {
  const FocusStackInputIssue({
    required this.fileName,
    required this.message,
  });

  final String fileName;
  final String message;
}

final class FocusStackInputValidation {
  const FocusStackInputValidation({
    required this.issues,
    required this.minimumInputCount,
    required this.inputCount,
  });

  final List<FocusStackInputIssue> issues;
  final int minimumInputCount;
  final int inputCount;

  bool get isValid => inputCount >= minimumInputCount && issues.isEmpty;
}

FocusStackInputValidation validateFocusStackInputs(
  List<RawInputFile> files, {
  int minimumInputCount = 2,
}) {
  if (minimumInputCount < 2) {
    throw ArgumentError.value(
      minimumInputCount,
      'minimumInputCount',
      '深度合成は最低2枚必要です。',
    );
  }

  final List<FocusStackInputIssue> issues = <FocusStackInputIssue>[];
  if (files.isEmpty) {
    return FocusStackInputValidation(
      issues: const <FocusStackInputIssue>[],
      minimumInputCount: minimumInputCount,
      inputCount: 0,
    );
  }

  final RawInputFile reference = files.first;
  final referenceProbe = reference.probe;
  final referenceMetadata = reference.metadata;

  if (referenceProbe == null || referenceMetadata == null) {
    issues.add(
      FocusStackInputIssue(
        fileName: reference.name,
        message: 'RAW形式またはセンサーメタデータを確認できません。',
      ),
    );
  }

  for (int index = 0; index < files.length; index++) {
    final RawInputFile file = files[index];
    final probe = file.probe;
    final metadata = file.metadata;

    if (probe == null || metadata == null) {
      if (index != 0 || referenceProbe != null || referenceMetadata != null) {
        issues.add(
          FocusStackInputIssue(
            fileName: file.name,
            message: 'RAW形式またはセンサーメタデータを確認できません。',
          ),
        );
      }
      continue;
    }
    if (referenceProbe == null || referenceMetadata == null || index == 0) {
      continue;
    }

    if (probe.format != referenceProbe.format) {
      issues.add(
        FocusStackInputIssue(
          fileName: file.name,
          message: 'RAW形式が1枚目と一致しません。',
        ),
      );
    }
    if (metadata.width != referenceMetadata.width ||
        metadata.height != referenceMetadata.height) {
      issues.add(
        FocusStackInputIssue(
          fileName: file.name,
          message: 'センサー画像サイズが1枚目と一致しません。',
        ),
      );
    }
    if (metadata.cfaPattern != referenceMetadata.cfaPattern) {
      issues.add(
        FocusStackInputIssue(
          fileName: file.name,
          message: 'CFA配列が1枚目と一致しません。',
        ),
      );
    }
    final a = metadata.metadata.activeArea;
    final b = referenceMetadata.metadata.activeArea;
    if (a.left != b.left ||
        a.top != b.top ||
        a.width != b.width ||
        a.height != b.height) {
      issues.add(
        FocusStackInputIssue(
          fileName: file.name,
          message: 'ActiveAreaが1枚目と一致しません。',
        ),
      );
    }
    if (metadata.metadata.orientation !=
        referenceMetadata.metadata.orientation) {
      issues.add(
        FocusStackInputIssue(
          fileName: file.name,
          message: '画像orientationが1枚目と一致しません。',
        ),
      );
    }
  }

  return FocusStackInputValidation(
    issues: List<FocusStackInputIssue>.unmodifiable(issues),
    minimumInputCount: minimumInputCount,
    inputCount: files.length,
  );
}
