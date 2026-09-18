import { createAbortError, createTimeoutError } from "./runtimeErrors";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError("処理を中止しました");
}

/** Queued requests do not consume a connection and are removed when cancelled. */
export class AbortableSemaphore {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid semaphore capacity");
    this.capacity = capacity;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.pending.shift()?.();
        });
      };
      const onAbort = () => {
        const index = this.pending.indexOf(grant);
        if (index >= 0) this.pending.splice(index, 1);
        reject(abortReason(signal!));
      };
      if (this.active < this.capacity) grant();
      else {
        this.pending.push(grant);
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

/** Share work while cancelling it only after its last interested caller leaves. */
export class CancellableRequestPool<T> {
  private readonly requests = new Map<string, {
    controller: AbortController; promise: Promise<T>; subscribers: number;
  }>();

  request(key: string, signal: AbortSignal | undefined, factory: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let entry = this.requests.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        return factory(controller.signal);
      });
      entry = { controller, promise, subscribers: 0 };
      this.requests.set(key, entry);
      const current = entry;
      void promise.finally(() => {
        if (this.requests.get(key) === current) this.requests.delete(key);
      }).catch(() => undefined);
    }
    const current = entry;
    current.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        current.subscribers -= 1;
        if (error !== null) reject(error);
        else resolve(value as T);
      };
      const onAbort = () => {
        finish(abortReason(signal!));
        if (current.subscribers === 0) {
          if (this.requests.get(key) === current) this.requests.delete(key);
          current.controller.abort(abortReason(signal!));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      current.promise.then((value) => finish(null, value), (error: unknown) => finish(error));
    });
  }
}

/** A timeout cancels the operation as well as the caller's wait. */
export function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) return Promise.reject(abortReason(parentSignal));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
      if (error) {
        controller.abort(error);
        reject(error);
      } else resolve(value as T);
    };
    const onAbort = () => finish(abortReason(parentSignal!));
    const timer = setTimeout(() => finish(createTimeoutError(message)), timeoutMs);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return operation(controller.signal);
    }).then(
      (value) => finish(null, value),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))
    );
  });
}
