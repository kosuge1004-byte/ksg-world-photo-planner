// 「使い方」（参照モード）と「チュートリアル」（訓練モード）の両方が
// このデータを共有する。内容は実際のApp.tsx / 各コンポーネントの実装を
// 読んで書き起こしたもので、想像で書いた説明文ではない。
//
// targetSelector: 実画面上のボタンをハイライトするためのCSSセレクタ。
//   未指定のステップは対象のハイライト無しでテキストだけ表示する
//   （ハンバーガーメニュー内の個別項目など、安定したセレクタを追加
//   すると変更箇所が広範囲になるものは今回見送っている）。
// liveCheck: チュートリアル（訓練）モードで、このステップに対応する
//   実際の操作が完了したかどうかをApp.tsxのライブ状態から判定する
//   関数。指定が無いステップは「次へ」ボタンで手動送りする。

export type TutorialLiveState = {
  hasSubjectPoint: boolean;
  hasTripodPoint: boolean;
  tripodCandidateCount: number;
  mapViewMode: "2d" | "3d";
  spotSearchOpen: boolean;
  celestialMenuOpen: boolean;
  lightPollutionEnabled: boolean;
  accuracyMode: "standard" | "highest";
};

export type TutorialStep = {
  id: string;
  title: string;
  body: string;
  targetSelector?: string;
  liveCheck?: (state: TutorialLiveState) => boolean;
};

export type TutorialModule = {
  id: string;
  title: string;
  summary: string;
  steps: TutorialStep[];
};

export const TUTORIAL_MODULES: TutorialModule[] = [
  {
    id: "core-loop",
    title: "① 基本の流れ：三脚候補点を出す",
    summary: "被写体ピンを置くだけで、天体と重なる三脚位置が自動で計算されます。",
    steps: [
      {
        id: "core-open-subject",
        title: "「被写体をマップで選択」をタップ",
        body: "地図の左下あたりにある「被写体をマップで選択」ボタンをタップすると、被写体を置くモードになります。",
        targetSelector: ".pin-button.subject",
      },
      {
        id: "core-tap-map",
        title: "地図をタップして被写体を置く",
        body: "山や建物など、写したいものの場所を地図上でタップしてください。そこに被写体ピンが立ちます。",
        liveCheck: (state) => state.hasSubjectPoint,
      },
      {
        id: "core-auto-candidates",
        title: "（自動）三脚候補点が計算される",
        body: "ここはボタン操作は不要です。被写体ピンを置いた時点で、太陽・月・天の川・北極星（「天体の表示」で全てONが初期値）それぞれについて、被写体と画角内で重なる地点をアプリが自動でDEM（地形データ）を使って探し始めます。計算完了まで数秒〜、地形によってはそれ以上かかることがあります。",
        liveCheck: (state) => state.tripodCandidateCount > 0,
      },
      {
        id: "core-place-candidate",
        title: "「三脚候補点に三脚設置」をタップ",
        body: "候補が出たら、この専用ボタンをタップするだけで三脚ピンをその候補位置へ置けます。候補が複数（天体が複数表示中）ある場合は選択ダイアログが出ます。手動で好きな場所に置きたい場合は「三脚位置をマップで選択」から地図タップでも置けます。",
        targetSelector: ".tripod-candidate-pin-button",
        liveCheck: (state) => state.hasTripodPoint,
      },
    ],
  },
  {
    id: "top-bar",
    title: "② 上部バー：焦点距離・カメラ高・プリセット・保存",
    summary: "撮影条件の基本設定と、構図の保存・呼び出し。",
    steps: [
      {
        id: "top-focal",
        title: "焦点距離（mm）",
        body: "使用するレンズの焦点距離を入力します。9〜1600mmの範囲、フルサイズ換算です。値を変えるとプレビューの画角がリアルタイムに変わります。",
        targetSelector: ".focal-setting",
      },
      {
        id: "top-height",
        title: "カメラ高（m）",
        body: "三脚に載せたカメラのレンズ中心の高さです。0.1〜10mの範囲。三脚候補点の計算にもこの高さが使われます。",
        targetSelector: ".height-setting",
      },
      {
        id: "top-preset",
        title: "プリセット",
        body: "保存済みの構図（被写体・三脚・日時・焦点距離などの組み合わせ）を呼び出します。",
        targetSelector: ".top-preset-button",
      },
      {
        id: "top-favorite",
        title: "☆ボタンで保存",
        body: "被写体ピンと三脚ピンを置いた状態でこのボタンを押すと、今の組み合わせ（構図）を保存できます。あとでプリセットから呼び出せます。",
        targetSelector: ".top-favorite-button",
      },
    ],
  },
  {
    id: "celestial",
    title: "③ 天体の表示・光害マップ",
    summary: "どの天体を対象にするか、光害マップの重ね方。",
    steps: [
      {
        id: "celestial-toggle",
        title: "「天体の表示」を開く",
        body: "太陽・月・天の川・北極星のチェックを個別にON/OFFできます。OFFにした天体は三脚候補点の計算対象からも外れます。",
        targetSelector: ".celestial-menu-button",
        liveCheck: (state) => state.celestialMenuOpen,
      },
      {
        id: "celestial-checks",
        title: "チェックボックスで個別に切替",
        body: "初期値は全てON（表示）です。天の川だけ調べたいときなどは、他をOFFにすると三脚候補点も天の川だけに絞られます。",
        targetSelector: ".celestial-checks",
      },
      {
        id: "celestial-light-pollution",
        title: "光害マップ（天の川ONのときだけ表示）",
        body: "NASA VIIRS Black Marbleの夜間光データを地図に重ねます。天の川がOFFだとこのチェックボックス自体が表示されません。3D最高精度（Google Photorealistic 3D Tiles）中はONにすると自動的に2D表示へ切り替わります。",
        targetSelector: ".light-pollution-toggle",
        liveCheck: (state) => state.lightPollutionEnabled,
      },
      {
        id: "celestial-reset",
        title: "「すべて表示」",
        body: "4つの天体すべてを一括でONに戻します。",
        targetSelector: ".celestial-reset-button",
      },
    ],
  },
  {
    id: "timeline",
    title: "④ 時間の操作",
    summary: "日時を変えて、天体の位置がどう動くか確認する。",
    steps: [
      {
        id: "timeline-now",
        title: "「現時刻」ボタン",
        body: "今の日時にジャンプします。",
        targetSelector: ".preview-now-button",
      },
      {
        id: "timeline-minute",
        title: "-1 / +1 ボタン",
        body: "1分単位で時刻を前後に動かせます。太陽・月がフレームに入るタイミングを細かく探すのに便利です。",
        targetSelector: ".timeline-minute-step-back",
      },
      {
        id: "timeline-date",
        title: "日付を変更",
        body: "撮影を予定している日付そのものを変更できます。",
        targetSelector: ".timeline-date-control",
      },
    ],
  },
  {
    id: "map-mode",
    title: "⑤ 2D／3D表示の切替",
    summary: "地図の表示モードを切り替える。",
    steps: [
      {
        id: "map-2d",
        title: "2D表示",
        body: "Googleマップの平面地図です。動作が軽く、まず場所を探すのに向いています。",
        targetSelector: "[data-tutorial-id=\"map-mode-2d\"]",
        liveCheck: (state) => state.mapViewMode === "2d",
      },
      {
        id: "map-3d",
        title: "3D表示",
        body: "国土地理院の標高データを使った立体地図です。遮蔽物（山や建物）の見通しを確認できます。精度設定でGoogle Photorealistic 3D Tiles（有料の従量制サービス）へ切り替えることもできます。",
        targetSelector: "[data-tutorial-id=\"map-mode-3d\"]",
        liveCheck: (state) => state.mapViewMode === "3d",
      },
      {
        id: "map-measure",
        title: "計測ボタン",
        body: "地図を2回タップすると、その間の距離を測れます。",
        targetSelector: "[data-tutorial-id=\"map-measure\"]",
      },
      {
        id: "map-fullscreen",
        title: "全画面ボタン",
        body: "地図を全画面表示にします。",
        targetSelector: "[data-tutorial-id=\"map-fullscreen\"]",
      },
    ],
  },
  {
    id: "spot-search",
    title: "⑥ スポット検索の使い方",
    summary: "「いつ・どこで撮れるか」を、期間を指定して自動探索する。",
    steps: [
      {
        id: "spot-open",
        title: "「スポット検索」ボタンをタップ",
        body: "地図の上部にある🔍スポット検索ボタンから検索画面を開きます。",
        targetSelector: ".map-search-toggle",
        liveCheck: (state) => state.spotSearchOpen,
      },
      {
        id: "spot-subject",
        title: "被写体地点を指定",
        body: "現在地図に置いてある被写体ピンがあればそれが初期値になります。履歴やお気に入りからも選べますし、新しく地図で指定することもできます。",
      },
      {
        id: "spot-celestial",
        title: "対象の天体を選ぶ",
        body: "太陽・月・天の川・北極星のどれを狙うか選びます。太陽は「日の出」「日没」などタイミングも選べます。",
      },
      {
        id: "spot-period",
        title: "期間・曜日・間隔を設定",
        body: "検索する日付範囲（1ヶ月など、またはカスタム開始日〜終了日）、対象の曜日、何分おきに調べるか（間隔）を設定します。",
      },
      {
        id: "spot-constraints",
        title: "現地条件・表示件数",
        body: "アクセス可否など現地の条件を絞り込めます。結果として何件表示するかも指定できます。",
      },
      {
        id: "spot-submit",
        title: "検索を実行",
        body: "条件を決めたら検索を実行します。バックグラウンドで日時ごとに三脚候補点の計算が進み、条件を満たす組み合わせが一覧に集まります。",
      },
      {
        id: "spot-apply",
        title: "結果を選んで「この構図を適用」",
        body: "一覧から気に入った結果をタップすると詳細（撮影日時・焦点距離・カメラ方位仰角・三脚位置・被写体位置）が見られます。「この構図を適用」を押すと、その被写体ピン・三脚ピン・日時がメイン画面にそのまま反映されます。",
      },
    ],
  },
  {
    id: "precision",
    title: "⑦ 精度設定（3D表示選択）",
    summary: "無料の標準3DとGoogle Photorealistic 3D Tiles（有料）の違い。",
    steps: [
      {
        id: "precision-standard",
        title: "標準3D表示（無料・初期値）",
        body: "Google Photorealistic 3D Tilesを使いません。天体計算・測地線・DEM・ジオイド・気象連動屈折補正など従量課金でない計算はどちらでも同じです。",
      },
      {
        id: "precision-highest",
        title: "Google Photorealistic 3D Tiles（有料）",
        body: "標準表示に加え、建物の立体形状を使った遮蔽判定・最終3D確認を行います。従量制サービスの利用量が増えるため、アプリ側で月間の利用回数に上限を設けています（超えると自動的に標準へ制限）。",
      },
    ],
  },
  {
    id: "other-screens",
    title: "⑧ その他の画面（ハンバーガーメニュー内）",
    summary: "カレンダー・月齢・ARカメラなど。",
    steps: [
      {
        id: "menu-open",
        title: "ハンバーガーメニュー（☰）を開く",
        body: "画面左上の三本線ボタンから、以下の各画面・設定にアクセスできます。",
        targetSelector: ".hamburger-button",
      },
      {
        id: "menu-calendar",
        title: "カレンダー",
        body: "撮影予定とプロジェクトを管理します。",
      },
      {
        id: "menu-moon-age",
        title: "月齢",
        body: "月の形と月齢をオフラインで確認できます。",
      },
      {
        id: "menu-ar",
        title: "ARカメラ",
        body: "スマホのカメラごしに実際の景色と3D・天体を重ねて確認できます。",
      },
      {
        id: "menu-map-sources",
        title: "地図出典",
        body: "使用している地図・標高データの出典元（Google Maps、Google Photorealistic 3D Tiles、国土地理院、OpenStreetMap、Cesium World Terrainなど）を確認できます。",
      },
    ],
  },
];

export function findStep(
  stepId: string
): { module: TutorialModule; step: TutorialStep; moduleIndex: number; stepIndex: number } | null {
  for (let moduleIndex = 0; moduleIndex < TUTORIAL_MODULES.length; moduleIndex += 1) {
    const module_ = TUTORIAL_MODULES[moduleIndex];
    const stepIndex = module_.steps.findIndex((step) => step.id === stepId);
    if (stepIndex >= 0) {
      return { module: module_, step: module_.steps[stepIndex], moduleIndex, stepIndex };
    }
  }
  return null;
}
