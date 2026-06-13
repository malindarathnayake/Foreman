/**
 * Python-compatibility helpers for SmartCrusher.
 *
 * Mirrors Python's json module output, str(), f"{x:.4g}", statistics module,
 * and hashlib.md5 to enable byte-identical serialization with Python code.
 *
 * Accepted cross-language divergences (intentionally out of scope):
 * - Python bool is a subtype of int and participates in numeric statistics
 *   (mean, stdev, etc.). TS excludes booleans from numeric stats.
 * - Python `statistics` module uses Fraction-exact summation internally;
 *   TS uses naive IEEE-754 double arithmetic. Borderline-tie comparisons
 *   (e.g. mean exactly on a threshold) may differ by the last ULP.
 * - Python json.dumps accepts NaN and Infinity (serializes as `NaN`/`Infinity`);
 *   TS passthrough behavior matches but output is not standard JSON in either case.
 * - JS regex character classes (\b, \w, \d) are ASCII-only; Python regex is
 *   Unicode-aware. Anchor extraction on non-ASCII text may differ.
 * - Container string repr escaping is simplified (partition-equivalent for
 *   the corpus — single vs double quote selection, escape sequences).
 */
/**
 * Scan JSON source text for number literals written in FLOAT form whose
 * value is an integer (e.g. "3.0", "1e2"). Returns a Set of those integer
 * values so serializers can re-render them Python-style ("3.0" not "3").
 *
 * Strings inside the JSON text are skipped; only top-level tokens are scanned.
 *
 * KNOWN LIMITATION: the set is value-global per document — if the same integral
 * value appears BOTH as an int literal and a float literal (e.g.
 * `{"a":1.0,"b":1}`), both render as `1.0`, unlike Python which preserves
 * per-occurrence int/float types. Output remains valid JSON with identical
 * numeric semantics; only byte-level Python parity is lost on such inputs.
 * Per-occurrence fidelity would require a custom JSON parser and is
 * intentionally out of scope.
 */
export declare function lexIntegralFloatLiterals(jsonText: string): Set<number>;
/**
 * Mirror Python's number representation for JSON output.
 * Integral floats (tracked via floatSet) are rendered with ".0" suffix
 * when the value is < 1e16 in magnitude, to match Python's json.dumps behavior.
 *
 * KNOWN LIMITATION: diverges from Python float repr in the following cases:
 * - |v| >= 1e16: Python emits e.g. `1e+16`, JS emits full digit string.
 * - Magnitudes 1e-5..1e-7: Python switches to scientific notation below 1e-4
 *   (e.g. `1e-05`); JS stays fixed-notation until below 1e-6.
 * - `-0.0`: Python renders `-0.0`, JS renders `0`.
 * All are out of corpus range; strategy strings and serialized bytes may
 * differ from Python for such values.
 */
export declare function pyNumberRepr(v: number, floatSet: ReadonlySet<number>): string;
/**
 * Mirror of Python `json.dumps(obj, ensure_ascii=False, separators=(",", ":"))`.
 * No spaces, insertion-order keys, non-ASCII characters preserved as-is.
 *
 * KNOWN LIMITATION: JS object property enumeration orders integer-like keys
 * (e.g. `"2"`, `"10"`) numerically first, while Python dicts preserve JSON
 * insertion order — so objects with integer-like string keys may serialize in
 * a different key order than Python. Key order carries no JSON semantics and
 * the CCR store always retains the original text, so no information is lost.
 */
export declare function pyJsonStringifyCompact(value: unknown, floatSet: ReadonlySet<number>): string;
/**
 * Mirror of Python `json.dumps(obj)` with default settings:
 * separators `", "` and `": "`, `ensure_ascii=True`.
 */
export declare function pyJsonDumpsDefault(value: unknown, floatSet: ReadonlySet<number>): string;
/**
 * Mirror of Python `json.dumps(obj, sort_keys=True)` with default settings.
 * Keys sorted (UTF-16 code unit order matches Python's sort).
 */
export declare function pyJsonDumpsSorted(value: unknown, floatSet: ReadonlySet<number>): string;
/**
 * Mirror of Python `str()` on JSON-parsed values.
 * Used as set-membership keys; equality fidelity matters.
 */
export declare function pyStr(value: unknown, floatSet: ReadonlySet<number>): string;
/**
 * Mirror of Python `f"{x:.4g}"`: 4 significant digits.
 *
 * KNOWN LIMITATION:
 * - Python `%.4g` switches to scientific notation below 1e-4; JS `toPrecision(4)`
 *   switches later — exact crossover may differ for values near 1e-4.
 * - Exact decimal ties (e.g. `1234.5` rounds to `1234` under Python banker's
 *   rounding, `1235` under JS round-half-up in toPrecision).
 * - `-0.0` renders as `0` (Python also renders `0` for `-0.0` in %.4g).
 */
export declare function pyG4(x: number): string;
/**
 * Python `round()` banker's rounding (round-half-to-even).
 * Nearest integer; exact .5 goes to the even neighbor.
 */
export declare function pyRound(x: number): number;
/** Arithmetic mean (sum / length). */
export declare function mean(xs: readonly number[]): number;
/** Median: sorted middle (odd) or average of two middles (even). */
export declare function median(xs: readonly number[]): number;
/** Sample variance: two-pass, denominator n-1. Caller guarantees n >= 2. */
export declare function sampleVariance(xs: readonly number[]): number;
/** Sample standard deviation. */
export declare function sampleStdev(xs: readonly number[]): number;
/**
 * Linear interpolation percentile on sorted values.
 * q in [0, 1]. Returns 0.0 for empty array, first value for single element.
 */
export declare function percentileLinear(sortedValues: readonly number[], q: number): number;
/** First 16 hex chars of MD5 hash of string (UTF-8 encoded). */
export declare function md5Hex16(s: string): string;
/** First 8 hex chars of MD5 hash of string (UTF-8 encoded). */
export declare function md5Hex8(s: string): string;
