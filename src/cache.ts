interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

// Na dit aantal set()-aanroepen voeren we een volledige sweep van verlopen
// entries uit, zodat keys die nooit meer opgevraagd worden toch verdwijnen.
const SWEEP_EVERY_N_SETS = 256;

export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private setsSinceSweep = 0;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: ververs de insertion order bij een hit (delete + set).
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Verwijder eerst een bestaande key zodat de nieuwe entry achteraan
    // (meest recent) in de insertion order komt.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });

    this.setsSinceSweep += 1;
    if (this.setsSinceSweep >= SWEEP_EVERY_N_SETS) {
      this.setsSinceSweep = 0;
      this.sweepExpired();
    }

    this.enforceCap();
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

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  private enforceCap(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

export const appCache = new TTLCache(1000);

export function makeCacheKey(prefix: string, input: unknown): string {
  return `${prefix}:${JSON.stringify(input)}`;
}
