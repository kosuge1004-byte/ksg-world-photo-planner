# Work349 / Work348 reviewed repair

最新基準は Work349。Version: 0.8.44+200。
最終スタックDNGのBaselineExposureは0 EVを維持。
2026-09-18。Work348下書きのregistration hard gateとflat-sky noise gateを検査・修正。
最高品質・元解像度・FP32を維持。

最新ユーザー指示はテストを含む検査とAPK作成。添付文書の過去結果は再実行結果と区別する。
修正: rollingのreferenceQualityStarsスコープ、不使用の旧noise proxy削除、非有限/空の残差と不正PSF検査、paired sample座標、sigma 0の測定、referenceに十分な支持があるのにfinal測定が失われるケースをFAIL。
隣接した反対符号の誤差が孤立した位置合わせ切替を互いに正当化する問題を修正。RGB残差の向きが一致する隣接候補、または3点目の連結候補で支持を確認。2px haloでタイル分割への依存を防ぐ。
algorithmRevision 349に更新し、旧版の結果を再利用しない。
4件の旧source contractは既存checkpoint APIとpureMax起動を認識するよう修正し、元の動作条件を保持。

Classic経路のフレーム別診断ログを追加。採用枚数不足の拒否前にも採否/残差/上限/coverage/weightを記録。
検査結果はWORK349_VALIDATION_RESULTS.jsonとWORK349_IMPLEMENTATION_REPORT_JA.mdを参照。
実機は接続されていない。Android実機/Adobe/iOS/Linux sanitizerの未実行をPASSと呼ばない。
全22引継ぎ項目の完了を主張しない。旧Work344引継ぎの残課題を今回の品質ゲートだけで解消済みと扱わない。
