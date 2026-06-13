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
import { createHash } from "node:crypto";
// ---------------------------------------------------------------------------
// 1. lexIntegralFloatLiterals
// ---------------------------------------------------------------------------
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
export function lexIntegralFloatLiterals(jsonText) {
    const result = new Set();
    let inString = false;
    let i = 0;
    const len = jsonText.length;
    while (i < len) {
        const ch = jsonText[i];
        if (inString) {
            if (ch === "\\") {
                i += 2; // skip escaped char
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }
        // Start of string
        if (ch === '"') {
            inString = true;
            i++;
            continue;
        }
        // Check for number token: starts with '-' followed by digit, or a digit
        const isDigit = ch >= "0" && ch <= "9";
        const isMinus = ch === "-" && i + 1 < len && jsonText[i + 1] >= "0" && jsonText[i + 1] <= "9";
        if (isDigit || isMinus) {
            // Consume the full number token
            let j = i;
            if (isMinus)
                j++; // consume '-'
            while (j < len && jsonText[j] >= "0" && jsonText[j] <= "9")
                j++;
            // optional fractional part
            if (j < len && jsonText[j] === ".") {
                j++;
                while (j < len && jsonText[j] >= "0" && jsonText[j] <= "9")
                    j++;
            }
            // optional exponent
            if (j < len && (jsonText[j] === "e" || jsonText[j] === "E")) {
                j++;
                if (j < len && (jsonText[j] === "+" || jsonText[j] === "-"))
                    j++;
                while (j < len && jsonText[j] >= "0" && jsonText[j] <= "9")
                    j++;
            }
            const token = jsonText.slice(i, j);
            // Only tokens that look like floats (contain '.', 'e', or 'E')
            if (token.includes(".") || token.includes("e") || token.includes("E")) {
                const v = Number(token);
                if (Number.isInteger(v)) {
                    result.add(v);
                }
            }
            i = j;
            continue;
        }
        i++;
    }
    return result;
}
// ---------------------------------------------------------------------------
// 5. pyNumberRepr (defined before use)
// ---------------------------------------------------------------------------
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
export function pyNumberRepr(v, floatSet) {
    if (Number.isInteger(v) && floatSet.has(v) && Math.abs(v) < 1e16) {
        return String(v) + ".0";
    }
    return String(v);
}
// ---------------------------------------------------------------------------
// 2. pyJsonStringifyCompact
// ---------------------------------------------------------------------------
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
export function pyJsonStringifyCompact(value, floatSet) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return pyNumberRepr(value, floatSet);
    if (typeof value === "string")
        return JSON.stringify(value); // JS default escaping; non-ASCII preserved
    if (Array.isArray(value)) {
        return "[" + value.map((el) => pyJsonStringifyCompact(el, floatSet)).join(",") + "]";
    }
    if (typeof value === "object" && value !== null) {
        const obj = value;
        const pairs = Object.keys(obj).map((k) => JSON.stringify(k) + ":" + pyJsonStringifyCompact(obj[k], floatSet));
        return "{" + pairs.join(",") + "}";
    }
    // Fallback for undefined, function, symbol — match JSON.stringify behavior
    return String(value);
}
// ---------------------------------------------------------------------------
// 3. pyJsonDumpsDefault
// ---------------------------------------------------------------------------
/**
 * Escape a single string value as Python json.dumps default (ensure_ascii=True).
 * Non-ASCII chars become \uXXXX. ASCII control chars and "/\" escaped as JSON.stringify does.
 */
function _escapeStringEnsureAscii(s) {
    // Build manually: use JSON.stringify for the escaping base, then re-escape non-ASCII
    let result = '"';
    for (let i = 0; i < s.length; i++) {
        const cp = s.charCodeAt(i);
        if (cp > 0x7e) {
            // Non-ASCII: escape as \uXXXX (lowercase hex, 4 digits)
            result += "\\u" + cp.toString(16).padStart(4, "0");
        }
        else {
            // ASCII: use JSON.stringify single-char escape
            const ch = s[i];
            switch (ch) {
                case '"':
                    result += '\\"';
                    break;
                case "\\":
                    result += "\\\\";
                    break;
                case "\n":
                    result += "\\n";
                    break;
                case "\r":
                    result += "\\r";
                    break;
                case "\t":
                    result += "\\t";
                    break;
                case "\b":
                    result += "\\b";
                    break;
                case "\f":
                    result += "\\f";
                    break;
                default:
                    if (cp < 0x20) {
                        result += "\\u" + cp.toString(16).padStart(4, "0");
                    }
                    else {
                        result += ch;
                    }
            }
        }
    }
    result += '"';
    return result;
}
function _pyJsonDumpsDefaultValue(value, floatSet) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return pyNumberRepr(value, floatSet);
    if (typeof value === "string")
        return _escapeStringEnsureAscii(value);
    if (Array.isArray(value)) {
        return "[" + value.map((el) => _pyJsonDumpsDefaultValue(el, floatSet)).join(", ") + "]";
    }
    if (typeof value === "object" && value !== null) {
        const obj = value;
        const pairs = Object.keys(obj).map((k) => _escapeStringEnsureAscii(k) + ": " + _pyJsonDumpsDefaultValue(obj[k], floatSet));
        return "{" + pairs.join(", ") + "}";
    }
    return String(value);
}
/**
 * Mirror of Python `json.dumps(obj)` with default settings:
 * separators `", "` and `": "`, `ensure_ascii=True`.
 */
export function pyJsonDumpsDefault(value, floatSet) {
    return _pyJsonDumpsDefaultValue(value, floatSet);
}
// ---------------------------------------------------------------------------
// 4. pyJsonDumpsSorted
// ---------------------------------------------------------------------------
function _pyJsonDumpsSortedValue(value, floatSet) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return pyNumberRepr(value, floatSet);
    if (typeof value === "string")
        return _escapeStringEnsureAscii(value);
    if (Array.isArray(value)) {
        return "[" + value.map((el) => _pyJsonDumpsSortedValue(el, floatSet)).join(", ") + "]";
    }
    if (typeof value === "object" && value !== null) {
        const obj = value;
        const sortedKeys = Object.keys(obj).slice().sort();
        const pairs = sortedKeys.map((k) => _escapeStringEnsureAscii(k) + ": " + _pyJsonDumpsSortedValue(obj[k], floatSet));
        return "{" + pairs.join(", ") + "}";
    }
    return String(value);
}
/**
 * Mirror of Python `json.dumps(obj, sort_keys=True)` with default settings.
 * Keys sorted (UTF-16 code unit order matches Python's sort).
 */
export function pyJsonDumpsSorted(value, floatSet) {
    return _pyJsonDumpsSortedValue(value, floatSet);
}
// ---------------------------------------------------------------------------
// 6. pyStr
// ---------------------------------------------------------------------------
/**
 * Inner repr helper for Python-style container rendering.
 * Strings use single quotes (switch to double if string contains ' but not ").
 */
function _pyReprInner(value, floatSet) {
    if (value === null)
        return "None";
    if (value === true)
        return "True";
    if (value === false)
        return "False";
    if (typeof value === "number")
        return pyNumberRepr(value, floatSet);
    if (typeof value === "string") {
        // Python uses single quotes, switches to double if string has ' but not "
        if (value.includes("'") && !value.includes('"')) {
            return '"' + value + '"';
        }
        return "'" + value + "'";
    }
    if (Array.isArray(value)) {
        return "[" + value.map((el) => _pyReprInner(el, floatSet)).join(", ") + "]";
    }
    if (typeof value === "object" && value !== null) {
        const obj = value;
        const pairs = Object.keys(obj).map((k) => _pyReprInner(k, floatSet) + ": " + _pyReprInner(obj[k], floatSet));
        return "{" + pairs.join(", ") + "}";
    }
    return String(value);
}
/**
 * Mirror of Python `str()` on JSON-parsed values.
 * Used as set-membership keys; equality fidelity matters.
 */
export function pyStr(value, floatSet) {
    if (value === null)
        return "None";
    if (value === true)
        return "True";
    if (value === false)
        return "False";
    if (typeof value === "number")
        return pyNumberRepr(value, floatSet);
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return "[" + value.map((el) => _pyReprInner(el, floatSet)).join(", ") + "]";
    }
    if (typeof value === "object" && value !== null) {
        const obj = value;
        const pairs = Object.keys(obj).map((k) => _pyReprInner(k, floatSet) + ": " + _pyReprInner(obj[k], floatSet));
        return "{" + pairs.join(", ") + "}";
    }
    return String(value);
}
// ---------------------------------------------------------------------------
// 7. pyG4
// ---------------------------------------------------------------------------
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
export function pyG4(x) {
    if (x === 0)
        return "0";
    const raw = x.toPrecision(4);
    if (raw.includes("e") || raw.includes("E")) {
        // Normalize to Python exponent style:
        // Strip trailing zeros in mantissa, drop trailing ".", pad exponent to 2 digits with sign
        const eIdx = raw.search(/[eE]/);
        let mantissa = raw.slice(0, eIdx);
        const expPart = raw.slice(eIdx + 1); // e.g. "+5" or "-05"
        // Strip trailing zeros and trailing decimal point
        if (mantissa.includes(".")) {
            mantissa = mantissa.replace(/\.?0+$/, "");
        }
        // Parse exponent and reformat
        const expVal = parseInt(expPart, 10);
        const expSign = expVal >= 0 ? "+" : "-";
        const expAbs = Math.abs(expVal).toString().padStart(2, "0");
        return mantissa + "e" + expSign + expAbs;
    }
    // Non-scientific: strip trailing zeros after decimal point, and trailing "."
    if (raw.includes(".")) {
        return raw.replace(/\.?0+$/, "");
    }
    return raw;
}
// ---------------------------------------------------------------------------
// 8. pyRound
// ---------------------------------------------------------------------------
/**
 * Python `round()` banker's rounding (round-half-to-even).
 * Nearest integer; exact .5 goes to the even neighbor.
 */
export function pyRound(x) {
    const floor = Math.floor(x);
    const frac = x - floor;
    if (frac < 0.5)
        return floor;
    if (frac > 0.5)
        return Math.ceil(x);
    // Exact halfway: round to even
    // Math.ceil(-0.5) === -0 in JS; use || 0 to convert -0 to +0
    return floor % 2 === 0 ? floor : (Math.ceil(x) || 0);
}
// ---------------------------------------------------------------------------
// 9. Statistics
// ---------------------------------------------------------------------------
/** Arithmetic mean (sum / length). */
export function mean(xs) {
    return xs.reduce((s, v) => s + v, 0) / xs.length;
}
/** Median: sorted middle (odd) or average of two middles (even). */
export function median(xs) {
    const sorted = xs.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
/** Sample variance: two-pass, denominator n-1. Caller guarantees n >= 2. */
export function sampleVariance(xs) {
    const m = mean(xs);
    return xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
}
/** Sample standard deviation. */
export function sampleStdev(xs) {
    return Math.sqrt(sampleVariance(xs));
}
/**
 * Linear interpolation percentile on sorted values.
 * q in [0, 1]. Returns 0.0 for empty array, first value for single element.
 */
export function percentileLinear(sortedValues, q) {
    const n = sortedValues.length;
    if (n === 0)
        return 0.0;
    if (n === 1)
        return sortedValues[0];
    const pos = q * (n - 1);
    const lo = Math.trunc(pos);
    const hi = lo + 1 < n ? lo + 1 : lo;
    const frac = pos - lo;
    return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}
// ---------------------------------------------------------------------------
// 10/11. md5 helpers
// ---------------------------------------------------------------------------
/** First 16 hex chars of MD5 hash of string (UTF-8 encoded). */
export function md5Hex16(s) {
    return createHash("md5").update(s, "utf8").digest("hex").slice(0, 16);
}
/** First 8 hex chars of MD5 hash of string (UTF-8 encoded). */
export function md5Hex8(s) {
    return createHash("md5").update(s, "utf8").digest("hex").slice(0, 8);
}
