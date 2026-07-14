# Code Review — `sessionCache.mjs`

## 1. CRITICAL — `get()` expiry check is inverted; cache always misses and can serve expired sessions

**Location:** `get(key)` — `if (entry.expiresAt > Date.now()) return undefined;`

The comparison is backwards. `expiresAt > Date.now()` is true when the entry is **still valid** (expiry is in the future) — yet in that case the method returns `undefined`. It only reaches `return entry.value` when `expiresAt <= Date.now()`, i.e. when the entry is **already expired**.

**Concrete failure:**
- For the entire lifetime of a fresh entry, `get()` returns `undefined` → every lookup is a cache miss. Since the module caches *authenticated session lookups* for an API gateway, every request falls through to the full session lookup, defeating the cache entirely (latency spike / load amplification on the auth backend, a self-inflicted DoS under traffic).
- In the narrow window where an entry is expired but its eviction timer has not yet run, `get()` returns the **stale/expired session** as if valid — an authorization-relevant staleness bug (a revoked or timed-out session can be honored).

The correct guard is `if (entry.expiresAt <= Date.now()) return undefined;` (return the value otherwise).

**Severity:** Critical (correctness + security). **CWE-613: Insufficient Session Expiration.**

---

## 2. HIGH — `warm()` does not await its work; resolves early and leaks unhandled rejections

**Location:** `warm(keys, loader)` — `keys.forEach(async (key) => { ... })`

`Array.prototype.forEach` ignores the promises returned by its `async` callback. The `async warm()` function therefore returns a promise that **resolves immediately**, before any `loader(key)` has completed — directly contradicting the doc comment ("resolve once all are cached"). Callers that `await warm(...)` and then read the cache will observe empty/partial results (a race with no synchronization point).

Additionally, each callback is a floating promise: if any `loader(key)` rejects, the rejection is **unhandled**. Under Node's default `unhandledRejection` behavior this is logged and can terminate the process — an availability risk in a gateway.

**Fix direction:** `await Promise.all(keys.map(async (key) => this.set(key, await loader(key))))`.

**Severity:** High (async correctness + process-stability). **CWE-248: Uncaught Exception.**

---

## 3. HIGH — `buildUrl()` interpolates query parameters without URL-encoding (parameter injection)

**Location:** `buildUrl` — `parts.push(`${k}=${v}`);`

Keys and values are concatenated raw. Any value containing `&`, `=`, `#`, spaces, or other reserved characters is injected verbatim into the query string. An attacker-influenced value such as `admin=true&x` (or `&role=root`) lets the caller **inject or override additional query parameters** (HTTP parameter pollution), and unencoded `#`/CRLF-style content can corrupt the request target. Because this feeds URLs used by the gateway's fetch helpers, it can be leveraged to alter downstream requests.

**Fix direction:** use `URLSearchParams` / `encodeURIComponent(k)` and `encodeURIComponent(v)`.

**Severity:** High (security). **CWE-116: Improper Encoding or Escaping of Output** (also relevant: **CWE-88: Argument/Parameter Injection**).

---

## 4. MEDIUM — `set()` on an existing key overwrites the timer handle without clearing the old timer

**Location:** `set(key, value)` — `this.timers[key] = setTimeout(...)`

When a key is re-`set` (e.g. session refresh) before its previous TTL elapses, the previous `setTimeout` handle is overwritten and **never cleared**. The stale timer still fires at the original expiry and calls `delete(key)`, which **prematurely evicts the freshly-set entry** — the refreshed session disappears earlier than its new TTL. It is also a transient timer/closure leak until it fires.

**Fix direction:** `clearTimeout(this.timers[key])` before assigning the new one.

**Severity:** Medium (correctness + resource leak).

---

## 5. MEDIUM — `delete()` never calls `clearTimeout`; dangling timers linger and keep the event loop alive

**Location:** `delete(key)` — `delete this.timers[key];`

Removing the map entry does not cancel the pending `setTimeout`. When a key is deleted explicitly (not via its own timer callback), the timer stays scheduled until the full TTL, then fires a no-op `delete`. With high key churn this accumulates many live timers holding closures over `this`/`key` (delayed GC), and because the timers are not `.unref()`'d they also keep the Node process from exiting cleanly.

**Fix direction:** `clearTimeout(this.timers[key])` in `delete`, and consider `.unref()` on the timers.

**Severity:** Medium (resource leak).

---

## 6. MEDIUM — Plain object used as a keyed store enables prototype-pollution / key-collision hazards

**Location:** `constructor` (`this.store = {}`, `this.timers = {}`) and all `this.store[key]` / `this.timers[key]` accesses.

Keys come from session identifiers and are used to index ordinary objects. Special keys such as `__proto__`, `constructor`, or `prototype` do not behave as normal data keys: `store["__proto__"] = {...}` manipulates the object's prototype rather than storing an entry, and `get("__proto__")` returns the prototype object (truthy `entry`), producing incorrect cache behavior. Inherited property names (`hasOwnProperty`, `toString`) also collide with the map semantics.

**Fix direction:** use a `Map` (or `Object.create(null)`) for `store` and `timers`.

**Severity:** Medium (security/robustness). **CWE-1321: Improperly Controlled Modification of Object Prototype Attributes ('Prototype Pollution').**

---

## 7. LOW — `retryFetch()` retries indiscriminately with no backoff

**Location:** `retryFetch` — the `for` loop / `catch` block.

Every thrown error is retried immediately (up to `maxRetries + 1` attempts) with **no delay or exponential backoff** and **no distinction between retryable (network) and non-retryable (4xx-equivalent / programmer) errors**. On a persistently failing dependency this produces a tight retry burst from every caller — a thundering-herd amplifier for a gateway. (Note also: `fetch` resolves rather than throws on HTTP 5xx, so status-based failures are not retried at all — depending on `fetchFn` semantics this may be intended.)

**Severity:** Low (resilience/efficiency).

---

## 8. LOW — TTL option validation: `options.ttl || DEFAULT_TTL_MS` mishandles `0`/falsy and negatives

**Location:** `constructor` — `this.ttl = options.ttl || DEFAULT_TTL_MS;`

A configured `ttl` of `0` (or any falsy value) is silently replaced by the 60s default, and negative or non-numeric values are accepted without validation (a negative TTL makes every entry expire immediately). Prefer an explicit `Number.isFinite`/`> 0` check with a nullish (`??`) fallback.

**Severity:** Low (robustness).
