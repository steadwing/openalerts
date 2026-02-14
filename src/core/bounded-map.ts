/**
 * Bounded Map with LRU Eviction
 * 
 * Prevents memory leaks by automatically pruning oldest entries when size limit is reached.
 * Uses LRU (Least Recently Used) eviction strategy.
 */

export type BoundedMapOptions = {
  /** Maximum number of entries */
  maxSize: number;
  /** Optional callback when entries are evicted */
  onEvict?: (key: string, value: unknown) => void;
  /** Optional TTL in ms for entries */
  ttlMs?: number;
};

export type BoundedMapStats = {
  size: number;
  maxSize: number;
  evictionCount: number;
  hitCount: number;
  missCount: number;
};

type Entry<V> = {
  value: V;
  accessTs: number;
  createTs: number;
};

export class BoundedMap<K extends string, V> {
  private map = new Map<K, Entry<V>>();
  private evictionCount = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly options: BoundedMapOptions) {
    if (options.maxSize <= 0) {
      throw new Error("maxSize must be positive");
    }
  }

  /** Set a value */
  set(key: K, value: V): this {
    const now = Date.now();

    // If key exists, update it
    if (this.map.has(key)) {
      this.map.set(key, { value, accessTs: now, createTs: this.map.get(key)!.createTs });
      return this;
    }

    // If at capacity, evict oldest entry
    if (this.map.size >= this.options.maxSize) {
      this.evictOldest();
    }

    this.map.set(key, { value, accessTs: now, createTs: now });
    return this;
  }

  /** Get a value */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    
    if (!entry) {
      this.missCount++;
      return undefined;
    }

    // Check TTL if configured
    if (this.options.ttlMs) {
      const age = Date.now() - entry.createTs;
      if (age > this.options.ttlMs) {
        this.delete(key);
        this.missCount++;
        return undefined;
      }
    }

    // Update access time (LRU)
    entry.accessTs = Date.now();
    this.hitCount++;
    return entry.value;
  }

  /** Check if key exists */
  has(key: K): boolean {
    if (!this.map.has(key)) return false;

    // Check TTL if configured
    if (this.options.ttlMs) {
      const entry = this.map.get(key)!;
      const age = Date.now() - entry.createTs;
      if (age > this.options.ttlMs) {
        this.delete(key);
        return false;
      }
    }

    return true;
  }

  /** Delete a key */
  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry) {
      this.options.onEvict?.(key, entry.value);
    }
    return this.map.delete(key);
  }

  /** Clear all entries */
  clear(): void {
    if (this.options.onEvict) {
      for (const [key, entry] of this.map) {
        this.options.onEvict(key, entry.value);
      }
    }
    this.map.clear();
  }

  /** Get current size */
  get size(): number {
    return this.map.size;
  }

  /** Get all keys */
  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  /** Get all values */
  values(): IterableIterator<V> {
    return Array.from(this.map.values()).map(e => e.value).values();
  }

  /** Get all entries */
  entries(): IterableIterator<[K, V]> {
    return Array.from(this.map.entries()).map(([k, e]) => [k, e.value] as [K, V]).values();
  }

  /** Get stats */
  getStats(): BoundedMapStats {
    return {
      size: this.map.size,
      maxSize: this.options.maxSize,
      evictionCount: this.evictionCount,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  /** Evict oldest (least recently used) entry */
  private evictOldest(): void {
    let oldestKey: K | undefined;
    let oldestTs = Infinity;

    for (const [key, entry] of this.map) {
      if (entry.accessTs < oldestTs) {
        oldestTs = entry.accessTs;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
      this.evictionCount++;
    }
  }
}

