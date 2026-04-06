interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    const now = Date.now();
    let n = 0;
    for (const [, entry] of this.store.entries()) {
      if (now <= entry.expiresAt) n += 1;
    }
    return n;
  }
}

export const appCache = new TTLCache();

export function makeCacheKey(prefix: string, input: unknown): string {
  return `${prefix}:${JSON.stringify(input)}`;
}
