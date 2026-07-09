# T1 — Implement a Semantic Version module (`semver.mjs`)

Implement a pure ES module that parses and compares semantic versions per
**Semantic Versioning 2.0.0**. No dependencies. Node ESM. Use named exports.

## Exports

### `parse(version)` → object
Returns `{ major, minor, patch, prerelease, build }` where `major/minor/patch`
are numbers, `prerelease` is an array of `(string | number)` identifiers, and
`build` is an array of strings.

Rules:
- An OPTIONAL leading `v` is allowed and stripped (`v1.2.3` → same as `1.2.3`).
- `major`, `minor`, `patch` are non-negative integers with **no leading zeros**
  (`0` is valid; `01` is invalid).
- Optional prerelease after `-`: dot-separated identifiers. Each identifier is
  either **numeric** (digits only, no leading zeros unless the identifier is
  exactly `0`) — returned as a `number` — or **alphanumeric** (`[0-9A-Za-z-]+`,
  containing at least one non-digit) — returned as a `string`.
- Optional build metadata after `+`: dot-separated identifiers `[0-9A-Za-z-]+`,
  returned as `string[]` (leading zeros ARE allowed in build identifiers).
- On ANY invalid input, throw a `TypeError`. Non-string input throws `TypeError`.

### `isValid(version)` → boolean
`true` if and only if `parse(version)` would succeed. Must NEVER throw
(e.g. `isValid(null)` returns `false`).

### `compare(a, b)` → `-1 | 0 | 1`
Return `-1` if `a` has lower precedence than `b`, `1` if higher, `0` if equal.
Precedence per SemVer 2.0.0 §11:
- Compare `major`, then `minor`, then `patch` numerically.
- A version WITH a prerelease has LOWER precedence than the same version
  WITHOUT one (`1.0.0-alpha` < `1.0.0`).
- Compare prerelease identifiers left to right:
  - two numeric identifiers compare numerically;
  - two alphanumeric identifiers compare by ASCII lexical order;
  - a numeric identifier ALWAYS has lower precedence than an alphanumeric one;
  - when all preceding identifiers are equal, the version with MORE prerelease
    fields has higher precedence (`1.0.0-alpha` < `1.0.0-alpha.1`).
- **Build metadata is IGNORED** for precedence (`1.0.0+a` == `1.0.0+b`).
- `compare` throws `TypeError` if either argument is not a valid version.

### Worked precedence example (must hold)
```
1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
  < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
```

## Constraints
- Pure functions. No I/O, no global state, no dependencies.
- Return values must match the types above exactly (numeric prerelease
  identifiers are `number`, not `string`).
