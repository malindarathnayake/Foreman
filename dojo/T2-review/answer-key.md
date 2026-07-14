# T2 answer key — GROUND TRUTH (never shown to a worker)

Target: `sessionCache.mjs`. 6 planted defects + 1 precision trap.

## Planted defects (recall set)

| # | Line | Type | Severity | CWE | Description |
|---|------|------|----------|-----|-------------|
| B1 | 22 | correctness / security | HIGH | CWE-613 | `get()` expiry comparison is **reversed**: `if (entry.expiresAt > Date.now()) return undefined` returns `undefined` for LIVE entries and returns the value for EXPIRED ones → cache never hits AND serves expired sessions (stale auth). Should be `<=` / `<`. |
| B2 | 33-36 | concurrency / async | HIGH | CWE-662 | `warm()` uses `keys.forEach(async …)` — `forEach` ignores the returned promises, so `warm()` resolves BEFORE any load completes and loader rejections are unhandled. Should use `await Promise.all(keys.map(…))`. |
| B3 | 9 | security | HIGH | CWE-1321 | Store is a plain object `{}`. `set('__proto__', …)` corrupts the prototype (prototype pollution); inherited keys (`get('toString')`) collide. Should be `new Map()` or `Object.create(null)`. |
| B4 | 8 | correctness | MEDIUM | CWE-1068 | `options.ttl || DEFAULT_TTL_MS` clobbers a caller-supplied `ttl` of `0` (falsy) with the default. Should use `??`. |
| B5 | 16 | resource leak / correctness | MEDIUM | CWE-401 | `set()` on an existing key schedules a second `setTimeout` without clearing the previous timer → timer leak, and the stale timer deletes the refreshed entry early. Should `clearTimeout(this.timers[key])` first. |
| B6 | 44 | security / correctness | MEDIUM | CWE-116 | `buildUrl()` interpolates query values without `encodeURIComponent` → breaks (and allows parameter injection) when a value contains `&`, `=`, spaces, or `#`. |

## Precision trap (flagging as a definite bug = false positive)

| Line | Note |
|------|------|
| 52 | `retryFetch` loop `attempt <= maxRetries` performs `maxRetries + 1` total attempts (1 initial + N retries). This is a defensible reading of "bounded number of retries" and is **intentional/correct**. Flagging it as a definite off-by-one is a false positive; asking to confirm intent or noting "no backoff delay" is an acceptable low-severity observation, not a planted bug. |

## Scoring

- **Recall** = planted defects found / 6.
- **Precision** = planted defects found / (planted found + false positives). Flagging line 52 as a bug, or inventing defects not in the module, counts against precision.
- **Security depth** = did the arm identify B3 (proto pollution) and B6 (encoding) as security issues with a correct/close CWE, and B1's expired-session angle?
- **Severity calibration** = does the arm rank B1/B2/B3 above B4/B5/B6?
