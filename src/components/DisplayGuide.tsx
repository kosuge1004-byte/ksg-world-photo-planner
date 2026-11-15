type Props = {
  onClose: () => void;
};

type GuideSample =
  | "line-sun"
  | "line-moon"
  | "line-milky-way"
  | "line-polaris"
  | "line-candidate-exact"
  | "line-candidate-estimate"
  | "line-sight"
  | "line-preview-track"
  | "line-measure"
  | "dot-sun"
  | "dot-moon"
  | "dot-milky-way"
  | "dot-polaris"
  | "dot-visible"
  | "pin-subject"
  | "pin-tripod"
  | "pin-pending"
  | "pin-person"
  | "timeline";

function GuideRow({
  sample,
  title,
  children,
}: {
  sample?: GuideSample;
  title: string;
  children: string;
}) {
  return (
    <div className="display-guide-row">
      <span
        className={sample ? `display-guide-sample ${sample}` : "display-guide-sample control"}
        aria-hidden="true"
      >
        {sample ? "" : "操作"}
      </span>
      <span className="display-guide-copy">
        <b>{title}</b>
        <small>{children}</small>
      </span>
    </div>
  );
}

/**
 * メイン画面に常時または条件付きで現れる線・点・ピン・操作部の凡例。
 * 描画側の名称と色に合わせ、推測を含む説明は置かない。
 */
export function DisplayGuide({ onClose }: Props) {
  return (
    <section id="display-guide" className="display-guide" aria-label="表示の説明">
      <div className="menu-panel-header">
        <strong>表示の説明</strong>
        <button type="button" onClick={onClose}>閉じる</button>
      </div>
      <p className="display-guide-intro">
        メイン画面に表示される線・点・ピン・ボタンの意味です。項目は、必要な位置や計算結果があるときだけ表示されます。
      </p>

      <section className="display-guide-section" aria-labelledby="display-guide-lines">
        <h3 id="display-guide-lines">地図上の線</h3>
        <GuideRow sample="line-sun" title="黄橙の破線（太陽）">
          被写体から、選択時刻の太陽方向へ伸びる探索基礎ラインです。
        </GuideRow>
        <GuideRow sample="line-moon" title="水色の破線（月）">
          被写体から、選択時刻の月方向へ伸びる探索基礎ラインです。
        </GuideRow>
        <GuideRow sample="line-milky-way" title="薄白／桃紫の破線（天の川）">
          被写体から、選択時刻の天の川中心方向へ伸びる探索基礎ラインです。2Dと3Dで見やすい色調が少し異なります。
        </GuideRow>
        <GuideRow sample="line-polaris" title="紫の破線（北極星）">
          被写体から北極星方向へ伸びる探索基礎ラインです。
        </GuideRow>
        <GuideRow sample="line-candidate-exact" title="赤の細い実線（三脚候補線・確定）">
          天体の出から入までの各時刻について、標高を含めて計算できた三脚候補点を結んだ線です。尾根などで解が途切れる区間は線も分かれます。
        </GuideRow>
        <GuideRow sample="line-candidate-estimate" title="赤の細い破線（三脚候補線・目安）">
          地面を平らと仮定した暫定の候補線です。標高計算済みの実線がある場合は実線を優先してください。
        </GuideRow>
        <GuideRow sample="line-sight" title="白の破線（3D地図のみ）">
          被写体の正式位置と、三脚のカメラレンズ中心を空間上で結ぶ視線です。
        </GuideRow>
      </section>

      <section className="display-guide-section" aria-labelledby="display-guide-points">
        <h3 id="display-guide-points">地図上の点・ピン</h3>
        <GuideRow sample="dot-sun" title="黄の点（太陽の三脚候補）">
          現在選択している太陽の時刻条件を満たす三脚候補点です。タップすると三脚を配置できます。
        </GuideRow>
        <GuideRow sample="dot-moon" title="水色の点（月の三脚候補）">
          現在選択している月の時刻条件を満たす三脚候補点です。
        </GuideRow>
        <GuideRow sample="dot-milky-way" title="桃紫の点（天の川の三脚候補）">
          現在選択している天の川の時刻条件を満たす三脚候補点です。
        </GuideRow>
        <GuideRow sample="dot-polaris" title="薄紫の点（北極星の三脚候補）">
          北極星の方向条件を満たす三脚候補点です。
        </GuideRow>
        <GuideRow sample="dot-visible" title="緑の小点（見通し確認済み）">
          「◎ 見通し」でDEM地形とPLATEAU建物の両方を調べ、被写体まで遮られないと確認できた点です。遮蔽あり・未確認・判定不能の点は緑で表示しません。
        </GuideRow>
        <GuideRow sample="pin-subject" title="赤いピン（被写体）">
          撮影する被写体の正式位置です。構造物では、取得できた高さ情報に基づく頂上位置を使います。
        </GuideRow>
        <GuideRow sample="pin-tripod" title="青いピン（三脚）">
          カメラを置く位置です。横の数値は被写体までの距離です。
        </GuideRow>
        <GuideRow sample="pin-pending" title="半透明で点滅するピン">
          置いた地点の地形・構造物の高さを確認中の仮ピンです。確定すると通常の赤または青のピンに置き換わります。
        </GuideRow>
        <GuideRow sample="pin-person" title="人物マーカー">
          前景・中景の大きさ比較に使う人物です。ピン設定から配置・身長変更・削除ができます。
        </GuideRow>
      </section>

      <section className="display-guide-section" aria-labelledby="display-guide-preview">
        <h3 id="display-guide-preview">上部の撮影プレビュー</h3>
        <GuideRow sample="line-preview-track" title="黄色の軌跡と時刻">
          選択天体が時間とともに通る位置です。地図用の三脚候補線・探索基礎ライン・白い視線は上部プレビューには表示しません。
        </GuideRow>
        <GuideRow sample="line-measure" title="青い破線と両端の点">
          「計測」で指定した2点間の3D距離です。2点を選ぶと距離が表示されます。
        </GuideRow>
        <GuideRow sample="pin-subject" title="小さい赤ピン">
          プレビュー内で見た被写体の正式位置です。
        </GuideRow>
        <GuideRow title="太陽・月・天の川・北極星">
          「天体の表示」で選んだ1種類を表示します。天体透明度は、時間軸を動かす間の重なり具合を調整します。
        </GuideRow>
        <GuideRow title="フレーム／＋・−／被写体">
          撮影枠を画面全体・3:2横・3:2縦から選択し、焦点距離を変更し、視線を被写体へ戻します。ピンチでも焦点距離、スワイプでも向きを補正できます。
        </GuideRow>
        <GuideRow title="位置指定／計測／全画面">
          3D表面上の正式な被写体位置を選ぶ、2点間を測る、プレビューを全画面にする操作です。
        </GuideRow>
        <GuideRow title="3D地図表示中の一時停止表示">
          通常は同じ3D描画を上下で同時に動かさず負荷を抑えます。「プレビューを表示」を選んだ場合だけ、追加通信・端末負荷を伴う同時表示になります。
        </GuideRow>
      </section>

      <section className="display-guide-section" aria-labelledby="display-guide-time">
        <h3 id="display-guide-time">時間軸</h3>
        <GuideRow sample="timeline" title="中央の白線と青い時刻">
          白線が現在選択中の撮影時刻です。目盛りを左右へ動かすと、天体・線・候補点がその時刻に更新されます。
        </GuideRow>
        <GuideRow title="目盛り下の色帯">
          太陽高度に応じて、昼・ゴールデンアワー・各薄明・夜を色分けします。場所が未設定のときは青色です。
        </GuideRow>
        <GuideRow title="日付／現在時刻／−1・＋1">
          日時を直接選ぶ、端末の現在時刻へ戻す、時刻を1分ずつ戻す・進める操作です。
        </GuideRow>
        <GuideRow title="日の出・日没・月出・月没・天の川">
          その場所と日付の時刻を表示します。カードを押すと該当時刻へ移動します。月出には月齢も表示します。
        </GuideRow>
        <GuideRow title="時計の検索ボタン">
          指定した条件で、天体が被写体付近を通過する日時を検索します。
        </GuideRow>
      </section>

      <section className="display-guide-section" aria-labelledby="display-guide-map-controls">
        <h3 id="display-guide-map-controls">2D・3D地図の操作</h3>
        <GuideRow title="スポット検索">
          登録スポット、保存済みスポット、地名検索から被写体を選びます。
        </GuideRow>
        <GuideRow title="通常地図／航空写真">
          2D地図の背景を切り替えます。天の川選択時は、設定により光害マップも重ねられます。
        </GuideRow>
        <GuideRow title="ピン配置">
          被写体・三脚・人物の配置、候補点への三脚配置、Googleマップへの位置送信を行います。
        </GuideRow>
        <GuideRow title="＋・−">
          地図を拡大・縮小します。地図のドラッグや3Dカメラ操作でも表示位置を変えられます。
        </GuideRow>
        <GuideRow title="◎ 見通し">
          赤い三脚候補線上の点をDEM地形とPLATEAU建物で確認し、遮蔽なしと確定した点だけを緑で表示します。
        </GuideRow>
        <GuideRow title="2D／3D 切替">
          平面地図と立体地図を切り替えます。2つを裏で同時に動かす切替ではありません。
        </GuideRow>
        <GuideRow title="計測（2D）">
          地図上で2点を順に選び、地表上の2地点間距離を表示します。
        </GuideRow>
        <GuideRow title="現在地／被写体／三脚">
          現在地を取得する、被写体を地図中央へ戻す、三脚を地図中央へ戻す操作です。
        </GuideRow>
        <GuideRow title="全画面">
          地図部分を全画面表示します。全画面中もスポット検索と地図操作を使えます。
        </GuideRow>
        <GuideRow title="画面下の状態表示">
          ピン配置、候補計算、データ待機、エラーなど、現在の処理状態と次に必要な操作を表示します。
        </GuideRow>
      </section>

      <section className="display-guide-section" aria-labelledby="display-guide-top">
        <h3 id="display-guide-top">画面上部の共通設定</h3>
        <GuideRow title="焦点距離">
          9～1600mm（フルサイズ換算）を指定します。値が大きいほどプレビューの画角が狭くなります。
        </GuideRow>
        <GuideRow title="カメラ高">
          三脚位置の地面からカメラのレンズ中心までの高さを指定します。
        </GuideRow>
        <GuideRow title="プリセット／☆">
          保存済みの撮影計画を開く、または現在の構図を保存します。
        </GuideRow>
      </section>

      <p className="display-guide-note">
        Google Photorealistic 3D Tilesは3D地図の見た目に使用します。高さ・候補計算にはDEM等を使い、「◎ 見通し」はDEM地形とPLATEAU建物を使用します。樹木・工事・仮設物など、元データに無い障害物は判定できません。
      </p>
    </section>
  );
}
