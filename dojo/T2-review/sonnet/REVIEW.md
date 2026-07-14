# Code Review: `sessionCache.mjs`

## 1. `get()` — TTL comparison is inverted, cache never returns a valid entry

**Location:** `SessionCache.get()`
```js
if (entry.expiresAt > Date.now()) return undefined;
return entry.value;
```

**What is wrong:** The comparison is backwards. `entry.expiresAt > Date.now()` is true exactly when the entry has **not** expired yet — for that case the code throws it away and returns `undefined`. `return entry.value` is only reached once `entry.expiresAt <= Date.now()`, i.e. **after** the entry has already expired.

Trace: `set(key, v)` at t=0 with ttl=60000 stores `expiresAt=60000`. Calling `get(key)` at t=5 evaluates `60000 > 5` → `true` → returns `undefined`. The value is only returned once t ≥ 60000, by which point it should have been evicted. Net effect: `get()` has a 100% miss rate on live entries — the cache never does what it's for, and every request falls through to whatever expensive session-lookup path this was meant to shield. Because `delete()` is scheduled via `setTimeout(..., this.ttl)` (fired at essentially the same instant `expiresAt` passes), there is also a real — and, under event-loop load, widening — window where an *expired* entry is what actually gets served.

**Severity:** CRITICAL
**CWE:** CWE-697 (Incorrect Comparison); secondary CWE-613 (Insufficient Session Expiration) for the expired-value-serving edge.

---

## 2. `warm()` — unhandled promise rejection can crash the process

**Location:** `SessionCache.warm()`
```js
keys.forEach(async (key) => {
  const value = await loader(key);
  this.set(key, value);
});
```

**What is wrong:** The callback is `async`, so it returns a Promise, but `Array.prototype.forEach` discards return values and nothing in `warm()` attaches a `.catch` or awaits them. If `loader(key)` rejects for any key (timeout, auth backend down — the exact failure mode a session loader will hit), that rejection is observed by nothing, producing an unhandled promise rejection. In Node's default configuration (`--unhandled-rejections=throw`, default since Node 15), an unhandled rejection terminates the process. Concrete failure: a single failing session lookup during a `warm()` call can take down the entire gateway process.

**Severity:** CRITICAL
**CWE:** CWE-248 (Uncaught Exception)

---

## 3. `set()` — stale timer from a previous `set()` deletes a freshly-written value

**Location:** `SessionCache.set()`
```js
this.timers[key] = setTimeout(() => this.delete(key), this.ttl);
```

**What is wrong:** Trace it: `set("A", v1)` at t=0 schedules `Timer1` to call `delete("A")` at t=ttl. `set("A", v2)` at t=100 (a routine "refresh this session" call, before `Timer1` fires) correctly overwrites `store["A"]` with the newer `{v2, expiresAt: ttl+100}` and reassigns `timers["A"]` to `Timer2` — but `Timer1` itself is never passed to `clearTimeout`, so it is still pending in Node's timer queue. At t=ttl, `Timer1` fires and calls `this.delete("A")`, which unconditionally deletes whatever is *currently* stored under `"A"` — i.e., it deletes `v2` up to 100ms early. Any key re-`set()` before its previous TTL elapses (the normal "extend session on activity" pattern) can be evicted prematurely by a stale timer left over from an earlier write. The abandoned `Timer1` (and its closure) also just leaks until it eventually fires.

**Severity:** HIGH
**CWE:** CWE-401 (Missing Release of Memory after Effective Lifetime) for the leaked timer

---

## 4. `warm()` — resolves before any key is actually cached

**Location:** `SessionCache.warm(keys, loader)` — the outer `async warm(...)` never awaits the work started by `forEach`

**What is wrong:** `warm` is declared `async` but contains no `await`/`Promise.all` over the per-key work; `forEach` runs the loop synchronously and returns immediately once all callbacks have been *started*, not finished. The promise `warm(...)` returns therefore resolves before any `loader(key)` call has completed or any `set()` has run — directly contradicting the function's own comment ("resolve once all are cached"). Concrete failure: `await cache.warm(keys, loader)` hands control back to the caller while every key is still in flight; code that assumes the cache is now warm and starts serving traffic will hit misses for all of them (compounding Finding 1) and may trigger duplicate concurrent loads per key.

**Severity:** HIGH
**CWE:** CWE-362 (Race Condition)

---

## 5. Prototype pollution via plain-object store

**Location:** `SessionCache` constructor (`this.store = {}`, `this.timers = {}`) and `set()`/`get()` (`this.store[key] = ...`, `this.store[key]`)

**What is wrong:** `store`/`timers` are bare `{}` objects, and `key` is used with bracket notation with no guard against special property names. If `key === "__proto__"`, then `this.store["__proto__"] = { value, expiresAt }` invokes `Object.prototype`'s `__proto__` accessor and replaces `store`'s own internal prototype with `{value, expiresAt}` — this is deterministic V8/Node behavior, not speculative. Once the prototype is corrupted, subsequent `get(otherKey)` lookups for keys that are not own properties can resolve through the polluted prototype chain instead of the intended `!entry → undefined` path. Since this is explicitly a cache for "authenticated session lookups" in a gateway, `key` is plausibly derived from client-supplied input (a cookie/token value), making `"__proto__"` an attacker-reachable key.

**Severity:** HIGH (contingent on `key` ever being derived from external input, which is likely given the module's stated purpose)
**CWE:** CWE-1321 (Prototype Pollution)

---

## 6. `buildUrl()` — no output encoding on query parameters

**Location:** `buildUrl()`
```js
parts.push(`${k}=${v}`);
```

**What is wrong:** Neither `k` nor `v` is passed through `encodeURIComponent`. A value containing `&` injects additional query parameters (e.g. `v = "x&admin=true"` silently adds `admin=true` to the request); a value containing `#` truncates the rest of the URL as a fragment; unescaped `%` sequences can desync downstream percent-decoding. For a gateway building outbound request URLs from parameters, this is parameter injection into requests sent to upstream services.

**Severity:** HIGH
**CWE:** CWE-116 (Improper Encoding or Escaping of Output), enabling argument/parameter injection

---

## 7. `delete()` never cancels its own timer

**Location:** `SessionCache.delete()`
```js
delete this.store[key];
delete this.timers[key];
```

**What is wrong:** `delete()` removes the object properties but never calls `clearTimeout(this.timers[key])` first. When `delete()` is invoked explicitly ahead of natural expiry (e.g., on logout / manual invalidation), the `setTimeout` scheduled by `set()` is still pending in Node's timer queue and keeps consuming memory (and keeping the event loop alive) until it eventually fires — at which point it's a harmless no-op `delete()` on an already-absent key, but the resource was held unnecessarily in the meantime.

**Severity:** MEDIUM
**CWE:** CWE-401 (Missing Release of Memory after Effective Lifetime)

---

## 8. `retryFetch()` — no backoff between attempts

**Location:** `retryFetch()`
```js
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  try { return await fetchFn(url); } catch (err) { lastErr = err; }
}
```

**What is wrong:** Retries fire back-to-back with zero delay. When the target is slow or overloaded, every caller immediately retries up to `maxRetries + 1` times, multiplying load on the exact dependency that is already struggling — a retry storm that can turn a transient blip into a cascading outage under concurrent gateway traffic.

**Severity:** MEDIUM
**CWE:** CWE-400 (Uncontrolled Resource Consumption)

---

## 9. Constructor silently discards an explicit `ttl: 0`

**Location:** `constructor()`
```js
this.ttl = options.ttl || DEFAULT_TTL_MS;
```

**What is wrong:** `||` treats any falsy value as "not supplied." A caller explicitly passing `{ ttl: 0 }` (e.g., to effectively disable caching) silently gets the 60-second default instead.

**Severity:** LOW

---

## 10. `retryFetch()` can throw `undefined`

**Location:** `retryFetch()` — `let lastErr;` … `throw lastErr;`

**What is wrong:** If `maxRetries < 0`, the loop condition `attempt <= maxRetries` (`0 <= negative`) is false on the first check, so the loop body never executes, `lastErr` stays `undefined`, and the function throws `undefined` instead of an `Error`. A caller doing `catch (e) { logger.error(e.message) }` gets a `TypeError` that masks the real problem.

**Severity:** LOW

---

## 11. `buildUrl(base, null)` throws

**Location:** `buildUrl(base, params = {})` — `for (const [k, v] of Object.entries(params))`

**What is wrong:** Default parameters only apply when the argument is `undefined`. A caller passing `null` explicitly (a common "no params" convention) bypasses the default and reaches `Object.entries(null)`, which throws `TypeError: Cannot convert undefined or null to object`.

**Severity:** LOW

---

## 12. Unbounded cache growth

**Location:** `SessionCache` (whole class) — `this.store` / `this.timers` have no maximum-size or eviction policy beyond per-key TTL

**What is wrong:** Nothing bounds the number of distinct keys held simultaneously; memory is bounded only by the rate at which keys expire versus the rate distinct new keys are `set()`. Sustained traffic with high key cardinality (organic or adversarial) grows both objects without limit.

**Severity:** LOW
**CWE:** CWE-770 (Allocation of Resources Without Limits or Throttling)
