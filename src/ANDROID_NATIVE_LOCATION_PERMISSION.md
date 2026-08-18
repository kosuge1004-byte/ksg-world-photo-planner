# Androidネイティブ位置情報権限

## 対応内容

- Capacitor 8のAndroidプロジェクトを追加
- アプリIDを `jp.ksg.worldphotoplanner` に固定
- `ACCESS_COARSE_LOCATION` をAndroidManifestへ追加
- `ACCESS_FINE_LOCATION` をAndroidManifestへ追加
- 現在地ボタンからAndroidの実行時権限要求を実行
- Android 12以降の「正確」「おおよそ」の両方へ対応
- 権限拒否時はKSGアプリ固有の設定画面を開く
- 端末全体の位置情報がOFFの場合は位置情報設定を開く
- Webブラウザ/PWAでは従来のWeb位置情報処理を維持
- 指定済みKSGアイコンをAndroidランチャーアイコンへ反映

## 重要な区別

Chromeの「ホーム画面に追加」で作成したPWAは、AndroidネイティブAPKとは
権限管理が異なります。今回追加したAndroidManifestの位置情報権限が
Android設定の「KSG World Photo Planner」へ表示されるのは、
このAndroidプロジェクトからビルドしてインストールしたAPK/AAB版です。

## 検証

```text
npm run verify:android  PASS
npm run build           PASS
npm run lint            PASS
npx cap sync android    PASS
npx cap doctor android  PASS
```

このPCにはJava、Android Studio、Android SDKがないため、
GradleによるAPKコンパイルと実機での権限ダイアログ確認は未実施です。
Android StudioとSDKを導入した環境では、次の順でビルドできます。

```text
npm install
npm run android:sync
npm run android:open
```

Android Studioで実機またはエミュレーターを選び、Runを実行します。
