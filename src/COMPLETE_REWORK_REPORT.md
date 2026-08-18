# KSG World Photo Planner 検索ロジック全面改修

## 実装済み
- 天体通過日時検索の方位角交差方式を廃止
- targetAzimuth / signedAngularDifference / refineCrossing を削除
- 検索順を「期間→曜日→時間帯→天体位置→画角判定を含む三脚位置算出→結果追加」に変更
- 時間帯外では天体位置計算・三脚探索・地形取得を実行しない
- 表示件数到達時に即return
- 結果へ三脚位置の緯度・経度・標高を保持
- 結果選択時に日時と三脚位置を適用
- alignmentErrorDegreesを公開型・結果・UIから削除
- sampleScoreをevaluateSampleへ変更し、Score名称を廃止
- 画角判定をフルサイズ固定の焦点距離判定に統一
- 太陽・月・天の川の全対象で画角内判定を実施
- 時間帯UI・日付またぎ・localStorage保持を維持
- APS-C / CropFactor関連コードがsrc内に存在しないことを確認

## ビルド確認
- npm installを複数回実行したが、実行環境の内部npmレジストリ応答待ちでタイムアウトし依存関係取得が完了しなかった。
- npm run buildは実行したが、未取得のvite/clientおよび@types/nodeのため停止した。
- したがって、この環境ではビルド成功を確認できていない。
