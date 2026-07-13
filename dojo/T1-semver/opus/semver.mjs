// semver.mjs — Semantic Versioning 2.0.0 implementation.
// Named exports: parse, isValid, compare. No dependencies. Node ESM.

const NUMERIC_ID = /^(?:0|[1-9]\d*)$/;
const ALPHANUM_ID = /^[0-9A-Za-z-]+$/;
const BUILD_ID = /^[0-9A-Za-z-]+$/;

function isNumericString(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return str.length > 0;
}

function parseCoreNumber(str) {
  // Non-negative integer, no leading zeros. "0" ok, "01" invalid.
  if (!NUMERIC_ID.test(str)) {
    throw new TypeError(`Invalid version core segment: "${str}"`);
  }
  return Number(str);
}

function parsePrereleaseIdentifier(id) {
  if (id.length === 0) {
    throw new TypeError("Empty prerelease identifier");
  }
  if (isNumericString(id)) {
    // Numeric identifier: digits only, no leading zeros unless exactly "0".
    if (id.length > 1 && id[0] === "0") {
      throw new TypeError(`Invalid numeric prerelease identifier (leading zero): "${id}"`);
    }
    return Number(id);
  }
  // Alphanumeric identifier: [0-9A-Za-z-]+ with at least one non-digit.
  if (!ALPHANUM_ID.test(id)) {
    throw new TypeError(`Invalid prerelease identifier: "${id}"`);
  }
  return id;
}

function parseBuildIdentifier(id) {
  // Build identifier: [0-9A-Za-z-]+, leading zeros allowed, always string.
  if (id.length === 0 || !BUILD_ID.test(id)) {
    throw new TypeError(`Invalid build identifier: "${id}"`);
  }
  return id;
}

export function parse(version) {
  if (typeof version !== "string") {
    throw new TypeError("Version must be a string");
  }

  let str = version;

  // Optional leading "v" is stripped.
  if (str.length > 0 && (str[0] === "v" || str[0] === "V")) {
    str = str.slice(1);
  }

  if (str.length === 0) {
    throw new TypeError("Empty version string");
  }

  // Split off build metadata (after first "+").
  let build = [];
  const plusIdx = str.indexOf("+");
  if (plusIdx !== -1) {
    const buildStr = str.slice(plusIdx + 1);
    str = str.slice(0, plusIdx);
    if (buildStr.length === 0) {
      throw new TypeError("Empty build metadata");
    }
    const buildParts = buildStr.split(".");
    build = buildParts.map(parseBuildIdentifier);
  }

  // Split off prerelease (after first "-").
  let prerelease = [];
  const dashIdx = str.indexOf("-");
  if (dashIdx !== -1) {
    const preStr = str.slice(dashIdx + 1);
    str = str.slice(0, dashIdx);
    if (preStr.length === 0) {
      throw new TypeError("Empty prerelease");
    }
    const preParts = preStr.split(".");
    prerelease = preParts.map(parsePrereleaseIdentifier);
  }

  // Remaining str is the version core: major.minor.patch.
  const coreParts = str.split(".");
  if (coreParts.length !== 3) {
    throw new TypeError(`Version core must have exactly 3 parts: "${str}"`);
  }

  const major = parseCoreNumber(coreParts[0]);
  const minor = parseCoreNumber(coreParts[1]);
  const patch = parseCoreNumber(coreParts[2]);

  return { major, minor, patch, prerelease, build };
}

export function isValid(version) {
  try {
    parse(version);
    return true;
  } catch {
    return false;
  }
}

function comparePrerelease(a, b) {
  // a, b are prerelease arrays. A non-empty prerelease has LOWER precedence
  // than an empty one (no prerelease).
  const aEmpty = a.length === 0;
  const bEmpty = b.length === 0;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // a has no prerelease → higher precedence
  if (bEmpty) return -1; // b has no prerelease → higher precedence

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const aNum = typeof ai === "number";
    const bNum = typeof bi === "number";

    if (aNum && bNum) {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    } else if (aNum && !bNum) {
      // Numeric always lower precedence than alphanumeric.
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      // Both alphanumeric: ASCII lexical order.
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }

  // All preceding identifiers equal: more fields → higher precedence.
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

export function compare(a, b) {
  const va = parse(a);
  const vb = parse(b);

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;

  return comparePrerelease(va.prerelease, vb.prerelease);
}
