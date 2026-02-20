export class TtlCache<K, V> {
  private readonly store = new Map<K, { expiresAt: number; value: V }>();

  get(key: K): V | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    this.store.set(key, {
      expiresAt: Date.now() + ttlMs,
      value,
    });
  }
}
