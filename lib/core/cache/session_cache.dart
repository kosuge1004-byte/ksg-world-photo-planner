import 'dart:io';

class SessionCache {
  SessionCache(this.directory);

  final Directory directory;

  Future<void> initialize() async {
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
  }

  Future<File> createTemporaryFile(String name) async {
    await initialize();
    return File('${directory.path}${Platform.pathSeparator}$name').create();
  }

  Future<void> clear() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }
}
