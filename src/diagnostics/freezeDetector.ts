/**
 * 画面全体が固まる(フリーズする)問題を、開発者ツールが使えないインストール
 * 型アプリ環境でも診断できるようにするための仕組み。
 *
 * 「固まっている最中」は当然ながら何のコードも実行できないため、フリーズを
 * 直接観測することはできない。その代わり、
 *   1) 重い処理を始める直前に、同期的に「今から何を始めるか」という目印
 *      (operationTag)を記録する（この記録自体は一瞬で終わる軽い操作）
 *   2) requestAnimationFrameで「前回の描画から今回の描画までの間隔」を
 *      監視し続ける
 *   3) その間隔が異常に長ければ(既定2秒以上)、「フリーズが起きていた」と
 *      判断し、固まる直前に記録しておいた目印を確認する
 * という方法で、フリーズの最中に何も実行できなくても、「何をしていた時に
 * 固まったか」を後から特定できるようにする。
 */

const FREEZE_THRESHOLD_MS = 2_000;
const MAX_RECORDED_FREEZES = 10;

export type FreezeEvent = {
  detectedAtIso: string;
  gapMs: number;
  operationTagAtFreezeStart: string | null;
  operationStartedAtMs: number | null;
};

let currentOperationTag: string | null = null;
let currentOperationStartedAtMs: number | null = null;
const recordedFreezes: FreezeEvent[] = [];
let monitoring = false;

/**
 * 重い可能性のある処理を始める直前に呼ぶ。処理が終わったら
 * endOperationTag()を呼ぶこと（呼び忘れても実害はない。次のタグ設定で
 * 上書きされるだけ）。
 */
export function beginOperationTag(tag: string): void {
  currentOperationTag = tag;
  currentOperationStartedAtMs = performance.now();
}

export function endOperationTag(tag: string): void {
  if (currentOperationTag === tag) {
    currentOperationTag = null;
    currentOperationStartedAtMs = null;
  }
}

export function getRecordedFreezes(): FreezeEvent[] {
  return [...recordedFreezes];
}

export function clearRecordedFreezes(): void {
  recordedFreezes.length = 0;
}

/**
 * フリーズ監視を開始する。アプリ起動時に1回だけ呼べばよい。
 */
export function startFreezeMonitoring(): () => void {
  if (monitoring) return () => {};
  monitoring = true;
  let lastFrameAtMs = performance.now();
  let rafId = 0;

  const tick = () => {
    const now = performance.now();
    const gapMs = now - lastFrameAtMs;
    if (gapMs >= FREEZE_THRESHOLD_MS) {
      const event: FreezeEvent = {
        detectedAtIso: new Date().toISOString(),
        gapMs: Math.round(gapMs),
        operationTagAtFreezeStart: currentOperationTag,
        operationStartedAtMs: currentOperationStartedAtMs,
      };
      recordedFreezes.push(event);
      if (recordedFreezes.length > MAX_RECORDED_FREEZES) {
        recordedFreezes.shift();
      }
      console.warn("[freeze-detector] 画面フリーズを検知しました", event);
    }
    lastFrameAtMs = now;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    monitoring = false;
    cancelAnimationFrame(rafId);
  };
}
