// sessionCache.mjs — in-memory session cache with TTL, plus small HTTP helpers.
// Used by the API gateway to cache authenticated session lookups.

const DEFAULT_TTL_MS = 60_000;

export class SessionCache {
  constructor(options = {}) {
    this.ttl = options.ttl || DEFAULT_TTL_MS;
    this.store = {};
    this.timers = {};
  }

  set(key, value) {
    const expiresAt = Date.now() + this.ttl;
    this.store[key] = { value, expiresAt };
    this.timers[key] = setTimeout(() => this.delete(key), this.ttl);
  }

  get(key) {
    const entry = this.store[key];
    if (!entry) return undefined;
    if (entry.expiresAt > Date.now()) return undefined;
    return entry.value;
  }

  delete(key) {
    delete this.store[key];
    delete this.timers[key];
  }

  // Pre-load a set of keys from the loader in parallel; resolve once all are cached.
  async warm(keys, loader) {
    keys.forEach(async (key) => {
      const value = await loader(key);
      this.set(key, value);
    });
  }
}

// Build a request URL with query parameters.
export function buildUrl(base, params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${v}`);
  }
  return parts.length ? `${base}?${parts.join("&")}` : base;
}

// Fetch with a bounded number of retries on failure.
export async function retryFetch(fetchFn, url, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchFn(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
