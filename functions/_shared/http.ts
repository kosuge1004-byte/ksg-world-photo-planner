export function jsonResponse(
  data: unknown,
  status = 200,
  cacheControl = "no-store"
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HttpRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

export function requestErrorStatus(error: unknown, fallback = 422): number {
  return error instanceof HttpRequestError ? error.status : fallback;
}

/** Read a JSON request without buffering an attacker-controlled body unboundedly. */
export async function readJsonRequest(
  request: Request,
  maximumBytes: number
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpRequestError("Content-Typeはapplication/jsonで指定してください", 415);
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new HttpRequestError("圧縮されたリクエスト本文には対応していません", 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpRequestError(`リクエスト本文は最大${maximumBytes}バイトです`, 413);
  }
  if (!request.body) throw new HttpRequestError("JSON本文がありません", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new HttpRequestError(`リクエスト本文は最大${maximumBytes}バイトです`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpRequestError("JSON本文が不正です", 400);
  }
}
