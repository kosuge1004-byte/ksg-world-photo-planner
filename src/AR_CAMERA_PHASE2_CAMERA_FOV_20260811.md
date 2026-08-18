# ARカメラ Phase 2: 実カメラ映像と画角情報

- ARカメラ全画面に背面カメラのリアルタイム映像を接続。
- Web/PWA/Capacitor共通部分は `navigator.mediaDevices.getUserMedia()` を使用。
- AndroidネイティブではCamera2 `CameraCharacteristics` を読む `KsgCameraInfo` Capacitor pluginを追加。
- 取得対象: cameraId、利用可能焦点距離、センサー物理サイズ、active array。
- WebView映像のデバイスlabelからAndroid Camera2 cameraIdを厳密に特定できた場合だけ、実焦点距離・センサーサイズから水平/垂直FOVを算出してAR投影情報として公開。
- cameraIdを特定できない場合は、別レンズのCamera2値を誤適用しない。映像は表示し、画角自動同期は保留と表示する。
- AndroidManifestにCAMERA権限とcamera featureを追加。
- ARを閉じる際はMediaStreamTrackを全停止し、カメラを確実に解放。

Phase 3では現在地・方位・姿勢追従を接続する。
