/**
 * 地名検索の表記ゆれ吸収（サーバー・ブラウザ共用、外部通信なし）。
 *
 * 2026-10-08: スポット検索の候補一覧化にあわせて追加。
 * - normalizedPlaceText: 候補名と検索語を「同じ場所の名前か」比較するための正規化。
 * - placeQueryVariants: 検索サービスへ送る検索語の言い換え（結果0件時の再検索用）。
 *
 * 比較用の正規化は積極的に揃える（誤って揃えても順位が僅かに変わるだけ）。
 * 一方、検索語の言い換えは外部サービスへの追加通信になるため、確実に同じ
 * 地名を指すものだけに絞り、件数も上限を設ける。
 */

// 地名・人名由来の施設名でよく現れる旧字体・異体字 → 新字体。
const KANJI_VARIANTS: Record<string, string> = {
  "澤": "沢", "濱": "浜", "濵": "浜", "邊": "辺", "邉": "辺", "齋": "斎", "齊": "斉",
  "嶋": "島", "嶌": "島", "髙": "高", "﨑": "崎", "碕": "崎", "國": "国", "嶽": "岳",
  "瀧": "滝", "櫻": "桜", "萬": "万", "廣": "広", "會": "会", "圓": "円", "德": "徳",
  "黑": "黒", "驛": "駅", "縣": "県", "區": "区", "淺": "浅", "榮": "栄", "眞": "真",
  "寶": "宝", "豐": "豊", "靜": "静", "鐵": "鉄", "龍": "竜", "瀨": "瀬", "濟": "済",
  "藏": "蔵", "彌": "弥", "禮": "礼", "與": "与", "惠": "恵", "鷗": "鴎", "燈": "灯",
  "舊": "旧", "樂": "楽", "氣": "気", "關": "関", "觀": "観", "廳": "庁",
  "學": "学", "橫": "横", "條": "条", "鹽": "塩", "乘": "乗", "顯": "顕",
  "之": "の",
};

// 「ヶ」「ケ」「が」が同じ地名で混在する語尾（霞ヶ関／霞が関、鎌ケ谷／鎌ヶ谷 など）。
const KE_FOLLOWERS = "丘岡谷原崎関岳峰浜浦島瀬池沢窪平根森淵鼻尾台洞城辻迫作窓嶽峯久保袋里花月";
// 後読み（lookbehind）は古いiOS Safariで構文エラーになるため、直前の1文字を
// キャプチャして置換側で戻す。
const KE_PATTERN = new RegExp(`(.)(?:[ヶヵ]|[ケが](?=[${KE_FOLLOWERS}]))`, "gu");
const NO_PATTERN = /(\p{Script=Han})[ノの](?=\p{Script=Han})/gu;

function replaceKanjiVariants(value: string): string {
  let result = "";
  for (const character of value) result += KANJI_VARIANTS[character] ?? character;
  return result;
}

function katakanaToHiragana(value: string): string {
  // ァ(30A1)〜ヴ(30F4)のみ。ヵ・ヶは地名の「ヶ」として別扱いにするため変換しない。
  return value.replaceAll(/[\u30A1-\u30F4]/gu, (character) =>
    String.fromCodePoint(character.codePointAt(0)! - 0x60)
  );
}

function hiraganaToKatakana(value: string): string {
  return value.replaceAll(/[\u3041-\u3094]/gu, (character) =>
    String.fromCodePoint(character.codePointAt(0)! + 0x60)
  );
}

/** 検索サービスへ送る前の最小限の整形（全角英数・全角空白・連続空白）。 */
export function cleanPlaceQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * 候補名と検索語の比較用キー。
 * 全角半角・大文字小文字・ひらがな/カタカナ・旧字体・「ヶ/ケ/が」・区切り記号の
 * 違いを同一視する。
 */
export function normalizedPlaceText(value: string): string {
  const unified = replaceKanjiVariants(value.normalize("NFKC").toLocaleLowerCase("ja"))
    .replaceAll(KE_PATTERN, "$1ヶ");
  return katakanaToHiragana(unified).replaceAll(/[\s,、。・･\-‐‑–—−ー'’"()（）]/gu, "");
}

/**
 * 検索サービスへ順に試す検索語。先頭は入力そのもの（整形のみ）。
 * 2件目以降は、先頭で1件も見つからなかった場合にだけ使う言い換え。
 */
export function placeQueryVariants(rawQuery: string, maxVariants = 4): string[] {
  const base = cleanPlaceQuery(rawQuery);
  if (!base) return [];
  const variants: string[] = [base];
  const add = (candidate: string): void => {
    const cleaned = candidate.trim();
    if (cleaned && !variants.includes(cleaned)) variants.push(cleaned);
  };

  // 旧字体 → 新字体（「之」→「の」は読みが変わりうるので比較専用とし、ここでは除く）。
  let modern = "";
  for (const character of base) {
    modern += character === "之" ? character : KANJI_VARIANTS[character] ?? character;
  }
  add(modern);

  // 「ヶ／ケ／が」の書き分け。
  if (modern.search(KE_PATTERN) >= 0) {
    for (const replacement of ["ヶ", "ケ", "が"]) add(modern.replaceAll(KE_PATTERN, `$1${replacement}`));
  }

  // 漢字に挟まれた「ノ／の」（虎ノ門／虎の門、丸の内／丸ノ内）。
  if (modern.search(NO_PATTERN) >= 0) {
    add(modern.replaceAll(NO_PATTERN, "$1ノ"));
    add(modern.replaceAll(NO_PATTERN, "$1の"));
  }

  // 空白で区切って入力された名称（「東京 タワー」）。
  if (modern.includes(" ")) add(modern.replaceAll(" ", ""));

  // 全てひらがなで入力された外来語名称（「すかいつりー」→「スカイツリー」）。
  if (/^[\u3041-\u3096ー\s]{3,}$/u.test(modern)) add(hiraganaToKatakana(modern));

  return variants.slice(0, Math.max(1, maxVariants));
}
