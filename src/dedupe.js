// Idempotency: Webflow retries non-200 deliveries (up to 3 more times, 10 minutes apart),
// so handlers must tolerate seeing the same event twice. Keyed on the signature, which is unique per delivery body+timestamp.

export class MemoryDedupe {
  constructor({ ttlMs = 60 * 60 * 1000, max = 10000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs; this.max = max; this.now = now; this.map = new Map();
  }
  async seen(key) {
    const t = this.map.get(key);
    if (t === undefined) return false;
    if (this.now() - t > this.ttlMs) { this.map.delete(key); return false; }
    return true;
  }
  async remember(key) {
    this.map.set(key, this.now());
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

/** Adapter for Cloudflare KV (or anything with get/put + expirationTtl). */
export class KvDedupe {
  constructor(kv, { ttlSeconds = 3600 } = {}) { this.kv = kv; this.ttlSeconds = ttlSeconds; }
  async seen(key) { return (await this.kv.get(`wf:${key}`)) !== null; }
  async remember(key) { await this.kv.put(`wf:${key}`, '1', { expirationTtl: this.ttlSeconds }); }
}
