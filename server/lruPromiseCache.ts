export type LruPromiseCacheOptions = {
  maxEntries: number;
  ttlMs?: number;
};

type CacheEntry<T> = {
  value: Promise<T>;
  touchedAt: number;
};

/**
 * Promise を共有する小型 LRU キャッシュ。
 * 同じキーへの同時要求を1本へ集約し、失敗した要求は自動的に破棄する。
 */
export class LruPromiseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly options: LruPromiseCacheOptions) {}

  get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.options.ttlMs && Date.now() - entry.touchedAt > this.options.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    entry.touchedAt = Date.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Promise<T>): Promise<T> {
    const entry: CacheEntry<T> = { value, touchedAt: Date.now() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  getOrCreate(key: string, factory: () => Promise<T>): Promise<T> {
    return this.get(key) ?? this.set(key, factory());
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private trim(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}
