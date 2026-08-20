export type UserNoticeTone = "warning" | "error";

export type UserNoticeEvent = {
  key: string;
  tone: UserNoticeTone;
  message: string;
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

export function toUserFacingErrorMessage(
  error: unknown,
  context: UserErrorContext
): string {
  const message = technicalMessage(error);
  const lower = message.toLocaleLowerCase();

  if (context === "google-maps-url") {
    return "Googleマップの共有URLを確認できませんでした。共有リンクを貼り直して、もう一度お試しください。";
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
