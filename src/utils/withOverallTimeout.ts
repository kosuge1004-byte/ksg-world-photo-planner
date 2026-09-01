/**
 * 与えられたPromiseに、内部の個々のステップの実装に関わらず「全体として」
 * 有効な上限時間を設ける。個々のステップ（IndexedDB読み取り・複数段階の
 * 逐次呼び出し等）にそれぞれ個別のタイムアウトがあっても、それらが直列に
 * 積み重なると合計の待ち時間は無制限に伸びうる。呼び出し元へ約束する
 * timeoutMsを、内部の一部分ではなく処理全体の上限として扱うために使う。
 */
export async function withOverallTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
