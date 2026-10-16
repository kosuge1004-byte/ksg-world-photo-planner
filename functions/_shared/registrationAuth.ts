/**
 * データサービス（パソコン側）からCloudflareへの呼び出しの認証。
 * /api/local-dem-register と同じ登録用トークン（LOCAL_DEM_REGISTRATION_TOKEN）を使う。
 */
export const REGISTRATION_TOKEN_HEADER = "X-AstroSight-Registration-Token";

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export function isAuthorizedRegistrationRequest(
  request: Request,
  configuredToken: string | undefined
): boolean {
  const configured = configuredToken?.trim() ?? "";
  const supplied = request.headers.get(REGISTRATION_TOKEN_HEADER) ?? "";
  return configured.length >= 32 && supplied.length >= 32 && constantTimeEqual(configured, supplied);
}
