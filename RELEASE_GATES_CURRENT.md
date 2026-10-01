# Current release gates

Baseline: Work364
Version: 0.8.46+202

静的解析、全Node/Flutter suite、Windows native suite、host RAW検査、APK build/ABI/署名/梱包の結果はWORK349_VALIDATION_RESULTS.jsonに記録（Work349時点）。Work350の結果はWORK350_VALIDATION_RESULTS.json。Work364の結果はWORK364_VALIDATION_RESULTS.json（Node contract・Native GCC Release+CTest・静的照合スクリプトのみ実行。Flutter analyze/test・Gradle/APK・実機は未実行）。
実機E2E、Adobe、iOS、Linux sanitizerは環境未提供。全gate完了ではない。
現行版の実行証拠だけをPASSとする。未実行を除外して「全検査成功」と表現しない。
