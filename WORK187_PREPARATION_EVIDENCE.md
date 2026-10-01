# Work187 preparation evidence

Checked 2026-08-20.

Official/public references used:
- Workmanager 0.10.7 package/changelog:
  https://pub.dev/packages/workmanager/changelog
- Workmanager API:
  https://pub.dev/documentation/workmanager/latest/workmanager/Workmanager-class.html
- Workmanager upstream Android README (foreground service permissions):
  https://github.com/fluttercommunity/flutter_workmanager/blob/main/workmanager_android/README.md
- Workmanager upstream README (onTaskStopped):
  https://github.com/fluttercommunity/flutter_workmanager/blob/main/README.md

Repository evidence:
- `.github/workflows/native-raw-abi.yml` pins Flutter 3.44.7 and Java 17.
- `android/gradle.properties` opts into Workmanager dataSync foreground service.
- `pubspec.yaml` uses workmanager ^0.10.7.
- Work187 preparation reran Node host tooling: 51/51 PASS.
- Work187 preparation reran Native Release CTest: 8/8 PASS.
- Shell syntax checks for both Work187 helper scripts: PASS.

Not executable in the ChatGPT environment:
- flutter pub get
- flutter analyze
- flutter test
- Android APK build
- adb / Pixel process-death tests

Reason: Flutter, Dart, and adb executables are absent from this runtime.
