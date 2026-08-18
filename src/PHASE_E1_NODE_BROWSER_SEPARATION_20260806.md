# Phase E1: Node / Browser 型依存分離

- server配下のDOMException依存を名前付きErrorへ置換。
- 共有検索経路のDOMException依存を共通runtimeErrorsへ置換。
- adaptiveConcurrencyからNavigator型依存を除去し、globalThisの構造型を使用。
- networkDiagnosticsからStorage型依存を除去し、必要最小限のStorageLikeを使用。
- IndexedDBは既存の構造型ラッパーを維持。
- tsconfig.node.jsonはDOMライブラリを追加せずES2023のまま維持。

完全ビルドは依存パッケージがローカルに無いため未実行。依存取得可能環境で `npm ci && npm run build` が必要。
