/**
 * AbortSignal.timeout / AbortSignal.any の代替（2026-10-09）。
 * iOS 17.4未満・Chrome 116未満（古いAndroid WebView）には AbortSignal.any が無く、
 * そのまま呼ぶと通信開始前に例外になる。ある端末では標準実装を使い、
 * 無い端末だけ同じ動作を AbortController で再現する。
 */
type AbortSignalStatics = {
  timeout?: (milliseconds: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

function statics(): AbortSignalStatics {
  return AbortSignal as unknown as AbortSignalStatics;
}

function timeoutReason(): unknown {
  try {
    return new DOMException("The operation timed out.", "TimeoutError");
  } catch {
    const error = new Error("The operation timed out.");
    error.name = "TimeoutError";
    return error;
  }
}

export function timeoutSignal(milliseconds: number): AbortSignal {
  const native = statics().timeout;
  if (typeof native === "function") return native.call(AbortSignal, milliseconds);
  const controller = new AbortController();
  setTimeout(() => controller.abort(timeoutReason()), milliseconds);
  return controller.signal;
}

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = statics().any;
  if (typeof native === "function") return native.call(AbortSignal, [...signals]);
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abortFrom = (source: AbortSignal): void => {
    for (const remove of listeners) remove();
    controller.abort(source.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const onAbort = (): void => abortFrom(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
}
