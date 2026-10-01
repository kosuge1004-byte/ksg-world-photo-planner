import 'dart:io';

import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/export/output_image_format.dart';

abstract interface class ResultFileActions {
  Future<String> saveCopy({
    required File sourceFile,
    required String suggestedName,
  });

  Future<void> share({
    required File sourceFile,
    Rect? sharePositionOrigin,
  });
}

typedef ShareResultFile = Future<void> Function({
  required File sourceFile,
  Rect? sharePositionOrigin,
});

final class PlatformResultFileActions implements ResultFileActions {
  PlatformResultFileActions({
    MethodChannel? channel,
    ShareResultFile? shareResultFile,
  })  : _channel = channel ?? const MethodChannel(_channelName),
        _shareResultFile = shareResultFile ?? _shareThroughPlatform;

  static const String _channelName = 'com.mobilestack.app/result_files';
  final MethodChannel _channel;
  final ShareResultFile _shareResultFile;

  @override
  Future<String> saveCopy({
    required File sourceFile,
    required String suggestedName,
  }) async {
    if (!await sourceFile.exists()) {
      throw ResultFileActionException('保存元の結果ファイルが見つかりません。');
    }
    final OutputImageFormat format = OutputImageFormat.fromPath(
      sourceFile.path,
    );
    final String? savedLocation = await _channel.invokeMethod<String>(
      'saveResult',
      <String, Object>{
        'sourcePath': sourceFile.path,
        'displayName': suggestedName,
        'mimeType': format.mimeType,
      },
    );
    if (savedLocation == null || savedLocation.trim().isEmpty) {
      throw ResultFileActionException('保存先を確認できませんでした。');
    }
    return savedLocation;
  }

  @override
  Future<void> share({
    required File sourceFile,
    Rect? sharePositionOrigin,
  }) async {
    if (!await sourceFile.exists()) {
      throw ResultFileActionException('共有する結果ファイルが見つかりません。');
    }
    await _shareResultFile(
      sourceFile: sourceFile,
      sharePositionOrigin: sharePositionOrigin,
    );
  }

  static Future<void> _shareThroughPlatform({
    required File sourceFile,
    Rect? sharePositionOrigin,
  }) async {
    final OutputImageFormat format = OutputImageFormat.fromPath(
      sourceFile.path,
    );
    await SharePlus.instance.share(
      ShareParams(
        files: <XFile>[
          XFile(sourceFile.path, mimeType: format.mimeType),
        ],
        subject: 'Mobile Stack 合成結果',
        sharePositionOrigin: sharePositionOrigin,
      ),
    );
  }
}

final class ResultFileActionException implements Exception {
  const ResultFileActionException(this.message);

  final String message;

  @override
  String toString() => message;
}
