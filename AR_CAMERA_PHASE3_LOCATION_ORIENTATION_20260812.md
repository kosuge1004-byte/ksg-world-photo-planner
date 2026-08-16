# AR Camera Phase 3 — location / heading / pose tracking

- AR起動中のみ高精度位置情報をwatchし、終了時に必ず解除する。
- Capacitorネイティブ環境では @capacitor/geolocation、Web/PWAでは Geolocation API を使用する。
- deviceorientationabsolute を優先し、未対応環境は deviceorientation にフォールバックする。
- iOSの webkitCompassHeading を優先して真北基準方位を取得する。
- Euler alpha/beta/gammaからの方位算出はalpha単独ではなく傾きを含めて計算する。
- iOSのDeviceOrientation権限はハンバーガーメニューのARカメラ押下というユーザー操作から要求する。
- 現在地が取得できた後はAR画面下部のタイムライン位置計算にも現在地を使用する。
- 被写体ピンの有無はAR起動条件にしない。検索の要件判定は従来どおり検索時のみ行う。
- Phase 4でこの位置・姿勢スナップショットを3Dカメラ投影へ接続する。
