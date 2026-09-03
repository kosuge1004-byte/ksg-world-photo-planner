export type UserNoticeTone = "warning" | "error";

export type UserNoticeEvent = {
  key: string;
  tone: UserNoticeTone;
  message: string;
  /**
   * 開発者へ問題を報告する際に役立つ技術的な詳細（元のエラーメッセージ、
   * 関連する数値、発生した機能名など）。指定された場合、通知に
   * 「詳細をコピー」ボタンが表示され、利用者が自分の意思でタップした
   * 時だけクリップボードへコピーされる（自動送信・自動収集はしない）。
   */
  diagnosticDetail?: string;
  /**
   * 2026-08-26追記: 「接続する」ボタンのような行動を要する通知
   * （actionLabelがある場合）だけでなく、見逃すと実害につながる重要な
   * 情報系の通知（例: Cesium ion無料枠の警告）も、画面中央に大きく
   * 表示したい場合に明示的に指定する。actionLabelの有無とは独立して
   * 制御できるようにする。
   */
  prominent?: boolean;
};

export type UserErrorContext =
  | "spot-search"
  | "google-maps-url"
  | "transit-search"
  | "highest-precision"
  | "preview"
  | "map";

type NoticeListener = (notice: UserNoticeEvent) => void;

const noticeListeners = new Set<NoticeListener>();
const lastPublishedAtByKey = new Map<string, number>();
const NOTICE_DEDUPLICATION_MS = 30_000;
const MAX_NOTICE_KEYS = 32;

export function subscribeUserNotices(listener: NoticeListener): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

export function publishUserNotice(notice: UserNoticeEvent): void {
  const now = Date.now();
  const lastPublishedAt = lastPublishedAtByKey.get(notice.key) ?? 0;
  if (now - lastPublishedAt < NOTICE_DEDUPLICATION_MS) return;
  lastPublishedAtByKey.delete(notice.key);
  lastPublishedAtByKey.set(notice.key, now);
  while (lastPublishedAtByKey.size > MAX_NOTICE_KEYS) {
    const oldestKey = lastPublishedAtByKey.keys().next().value;
    if (oldestKey === undefined) break;
    lastPublishedAtByKey.delete(oldestKey);
  }
  noticeListeners.forEach((listener) => listener(notice));
}

function technicalMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/**
 * AggregateError（例: 三脚候補計算で複数天体すべてが失敗した場合）は、
 * それ自身の.messageが「すべて失敗しました」のような一括の要約文言に
 * とどまり、本当の原因（.errorsに入っている個々の失敗理由）が
 * technicalMessage()だけでは診断コピーに出てこなかった。各要素の
 * メッセージ・スタックを展開し、実際に何が起きたかを追えるようにする。
 */
function expandAggregateError(error: unknown, depth = 0): string[] {
  if (depth > 3 || !(error instanceof Error)) return [];
  const lines: string[] = [];
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    error.errors.forEach((inner, index) => {
      const message = inner instanceof Error ? inner.message : String(inner);
      const name = inner instanceof Error ? inner.name : "Error";
      lines.push(`  内訳${index + 1}: ${name}: ${message}`);
      if (inner instanceof Error && inner.stack) {
        lines.push(`    stack: ${inner.stack.replace(/\s+/g, " ").slice(0, 400)}`);
      }
      lines.push(...expandAggregateError(inner, depth + 1).map((line) => `  ${line}`));
    });
  }
  return lines;
}

/**
 * 「詳細をコピー」ボタンに渡す診断テキストを組み立てる。
 * 個人が特定できる情報（氏名・端末固有IDなど）は含めない。
 * 発生時刻・機能名・技術的なエラーメッセージ・任意の補足情報のみ。
 * 座標や被写体名など、利用者自身が入力した検索内容が含まれる場合が
 * あるため、送信ではなく「コピーして本人が貼り付ける」形にとどめ、
 * 何が含まれるかは常にコピー前にボタンのそばへ明示する。
 */
export function buildDiagnosticDetail(
  featureName: string,
  error: unknown,
  extra?: Record<string, string | number | boolean | undefined>
): string {
  const lines = [
    `[AstroSightエラー報告]`,
    `機能: ${featureName}`,
    `日時: ${new Date().toISOString()}`,
    `エラー内容: ${technicalMessage(error) || String(error)}`,
  ];
  const aggregateDetails = expandAggregateError(error);
  if (aggregateDetails.length > 0) lines.push(...aggregateDetails);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

export function toUserFacingErrorMessage(
  error: unknown,
  context: UserErrorContext
): string {
  const message = technicalMessage(error);
  const lower = message.toLocaleLowerCase();

  if (context === "google-maps-url") {
    // サーバー側（functions/api/resolve-google-maps.ts）が返す詳細
    // （例: GOOGLE_HTTP_ERROR、REDIRECT_LIMIT、INVALID_GOOGLE_MAPS_URL等の
    // エラーコードを含む文言）を末尾に残す。原因ごとに毎回同じ一律の文言に
    // 丸めてしまうと、実際に何が起きているか（無効なURLなのか、通信エラー
    // なのか、転送回数超過なのか）が本人にも開発側にも分からなくなるため。
    const detail = message.replace(/^共有URLの解析に失敗しました：?/, "").trim();
    const base = "Googleマップの共有URLを確認できませんでした。共有リンクを貼り直して、もう一度お試しください。";
    return detail ? `${base}（詳細: ${detail}）` : base;
  }
  if (
    lower.includes("googleマップ") ||
    lower.includes("google maps") ||
    lower.includes("共有url") ||
    lower.includes("共有リンク")
  ) {
    return "Googleマップの共有URLを確認できませんでした。共有リンクを貼り直して、もう一度お試しください。";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("タイムアウト") ||
    lower.includes("時間内") ||
    lower.includes("応答が停止")
  ) {
    return "処理が時間内に完了しませんでした。通信状態を確認して、もう一度お試しください。";
  }
  if (lower.includes("気象") || lower.includes("天気")) {
    return context === "highest-precision"
      ? "Googleタイルモードに必要な天気データを取得できませんでした。時間をおいて、もう一度お試しください。"
      : "天気データを取得できませんでした。標準的な大気条件で計算します。";
  }
  if (context === "highest-precision") {
    return "Googleタイルモードのデータを取得できませんでした。標準モードへは変更していません。通信状態を確認して、もう一度お試しください。";
  }
  if (
    message.includes("見つかりません") ||
    message.includes("入力してください") ||
    message.includes("正しく指定してください") ||
    message.includes("開始日") ||
    message.includes("終了日")
  ) {
    return message;
  }
  if (
    lower.includes("api") ||
    lower.includes("http") ||
    lower.includes("通信") ||
    lower.includes("応答形式") ||
    lower.includes("network") ||
    lower.includes("fetch")
  ) {
    return "必要なデータを通信先から取得できませんでした。通信状態を確認して、もう一度お試しください。";
  }

  switch (context) {
    case "spot-search":
      return "スポット検索を完了できませんでした。入力内容と通信状態を確認して、もう一度お試しください。";
    case "transit-search":
      return "日時検索を完了できませんでした。条件と通信状態を確認して、もう一度お試しください。";
    case "preview":
      return "プレビューを更新できませんでした。ピンまたは日時を確認して、もう一度お試しください。";
    case "map":
      return "3D地図を読み込めませんでした。2D地図は利用できます。通信状態を確認して再試行してください。";
    default:
      return "処理を完了できませんでした。通信状態を確認して、もう一度お試しください。";
  }
}
