# Work186 -> Work187 引き継ぎ

Work186では画像処理アルゴリズムを変更せず、Android WorkManagerの状態整合性と二重起動防止を強化した。

Work187で最初に行うこと:
1. Flutter 3.44.7環境で `flutter pub get` を実行し、古い `pubspec.lock` を再生成する。
2. `flutter analyze`。
3. `flutter test`。
4. CIと同条件の Android arm64 debug APK build。
5. Pixel 9 Proでprocess death/relaunch試験。

注意:
- Work186時点で `workmanager` は実在確認済みの `^0.10.7`。
- `pubspec.lock` はWork183以降の追加pluginを含んでいないため、Work186のPASS材料として扱わない。
- `.flutter-plugins-dependencies` はホスト固有の生成物かつ古いため削除済み。`flutter pub get` で再生成される。
- 画質系ソースはWork185から変更していない。
- 残り時間(ETA)は表示しない。
