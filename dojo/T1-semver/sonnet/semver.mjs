// Implement per ../spec.md (SemVer 2.0.0). Named exports. No dependencies.

const SEMVER_REGEX =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_IDENTIFIER_RE = /^(0|[1-9]\d*)$/;

export function parse(version) {
  if (typeof version !== "string") {
    throw new TypeError("Invalid version: expected a string");
  }

  const match = SEMVER_REGEX.exec(version);
  if (!match) {
    throw new TypeError(`Invalid version: ${version}`);
  }

  const [, majorStr, minorStr, patchStr, prereleaseStr, buildStr] = match;

  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);

  const prerelease = prereleaseStr
    ? prereleaseStr.split(".").map((identifier) => {
        return NUMERIC_IDENTIFIER_RE.test(identifier)
          ? Number(identifier)
          : identifier;
      })
    : [];

  const build = buildStr ? buildStr.split(".") : [];

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

function compareIdentifiers(a, b) {
  const aIsNumber = typeof a === "number";
  const bIsNumber = typeof b === "number";

  if (aIsNumber && bIsNumber) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  if (aIsNumber && !bIsNumber) return -1;
  if (!aIsNumber && bIsNumber) return 1;

  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function compare(a, b) {
  const va = parse(a);
  const vb = parse(b);

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;

  const aHasPrerelease = va.prerelease.length > 0;
  const bHasPrerelease = vb.prerelease.length > 0;

  if (aHasPrerelease && !bHasPrerelease) return -1;
  if (!aHasPrerelease && bHasPrerelease) return 1;
  if (!aHasPrerelease && !bHasPrerelease) return 0;

  const len = Math.min(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const cmp = compareIdentifiers(va.prerelease[i], vb.prerelease[i]);
    if (cmp !== 0) return cmp;
  }

  if (va.prerelease.length !== vb.prerelease.length) {
    return va.prerelease.length < vb.prerelease.length ? -1 : 1;
  }

  return 0;
}
