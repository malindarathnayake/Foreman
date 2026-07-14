// Implement per ../spec.md (SemVer 2.0.0). Named exports. No dependencies.

/**
 * Parse a semantic version string into its components.
 * @param {string} version - The version string to parse.
 * @returns {{major:number, minor:number, patch:number, prerelease:Array<string|number>, build:Array<string>}}
 * @throws {TypeError} If the version string is invalid.
 */
export function parse(version) {
  if (typeof version !== 'string') {
    throw new TypeError('Version must be a string');
  }
  if (version.length === 0) {
    throw new TypeError('Version string cannot be empty');
  }

  let i = 0;
  // Optional leading 'v'
  if (version.charAt(0) === 'v') {
    i = 1;
  }

  // Helper to check if a character is a digit
  const isDigit = ch => ch >= '0' && ch <= '9';

  // Parse numeric identifier (major, minor, patch)
  function parseNumericIdentifier(start) {
    if (start >= version.length || !isDigit(version.charAt(start))) {
      throw new TypeError('Expected numeric identifier');
    }
    let end = start;
    while (end < version.length && isDigit(version.charAt(end))) {
      end++;
    }
    const numStr = version.slice(start, end);
    // No leading zeros unless the number is exactly 0
    if (numStr.length > 1 && numStr.charAt(0) === '0') {
      throw new TypeError('Leading zeros are not allowed in numeric identifiers');
    }
    const value = parseInt(numStr, 10);
    return { value, next: end };
  }

  // Parse major
  const { value: major, next: i1 } = parseNumericIdentifier(i);
  if (i1 >= version.length || version.charAt(i1) !== '.') {
    throw new TypeError('Expected dot after major version');
  }
  // Parse minor
  const { value: minor, next: i2 } = parseNumericIdentifier(i1 + 1);
  if (i2 >= version.length || version.charAt(i2) !== '.') {
    throw new TypeError('Expected dot after minor version');
  }
  // Parse patch
  const { value: patch, next: i3 } = parseNumericIdentifier(i2 + 1);
  let prerelease = [];
  let build = [];
  let pos = i3 + 1;

  if (pos < version.length) {
    const ch = version.charAt(pos);
    if (ch === '-') {
      // Parse prerelease identifiers
      const { ids: preIds, next: preEnd } = parsePrereleaseIdentifiers(version, pos + 1);
      prerelease = preIds;
      pos = preEnd;
      if (pos < version.length) {
        if (version.charAt(pos) !== '+') {
          throw new TypeError('Expected + after prerelease');
        }
        const { ids: buildIds, next: buildEnd } = parseBuildIdentifiers(version, pos + 1);
        build = buildIds;
        pos = buildEnd;
      }
    } else if (ch === '+') {
      // Parse build identifiers only
      const { ids: buildIds, next: buildEnd } = parseBuildIdentifiers(version, pos + 1);
      build = buildIds;
      pos = buildEnd;
    } else {
      throw new TypeError('Unexpected character after patch version');
    }
  }

  if (pos !== version.length) {
    throw new TypeError('Extra characters after version');
  }

  return { major, minor, patch, prerelease, build };
}

/**
 * Parse prerelease identifiers from a string starting at given index.
 * @param {string} str - The version string.
 * @param {number} start - Index after the leading '-'.
 * @returns {{ids:Array<string|number>, next:number}} - Array of identifiers and position after last identifier.
 */
function parsePrereleaseIdentifiers(str, start) {
  const ids = [];
  let pos = start;
  while (true) {
    const { id, next: idEnd } = parsePrereleaseIdentifier(str, pos);
    ids.push(id);
    if (idEnd >= str.length) {
      break;
    }
    if (str.charAt(idEnd) !== '.') {
      throw new TypeError('Expected dot between prerelease identifiers');
    }
    pos = idEnd + 1;
    if (pos >= str.length) {
      throw new TypeError('Empty prerelease identifier');
    }
  }
  return { ids, next: idEnd };
}

/**
 * Parse a single prerelease identifier.
 * @param {string} str - The version string.
 * @param {number} start - Index of first character of identifier.
 * @returns {{id:string|number, next:number}} - Identifier value and position after identifier.
 */
function parsePrereleaseIdentifier(str, start) {
  if (start >= str.length) {
    throw new TypeError('Empty prerelease identifier');
  }
  let end = start;
  while (end < str.length && str.charAt(end) !== '.' && str.charAt(end) !== '+') {
    end++;
  }
  const ident = str.slice(start, end);
  if (ident === '') {
    throw new TypeError('Empty prerelease identifier');
  }
  // Validate allowed characters: ASCII alphanumeric and hyphen
  if (!/^[0-9A-Za-z-]+$/.test(ident)) {
    throw new TypeError('Invalid prerelease identifier');
  }
  // Determine if numeric (all digits)
  if (/^\d+$/.test(ident)) {
    // Numeric: no leading zeros unless exactly "0"
    if (ident.length > 1 && ident.charAt(0) === '0') {
      throw new TypeError('Leading zeros are not allowed in numeric prerelease identifiers');
    }
    return { id: parseInt(ident, 10), next: end };
  } else {
    // Alphanumeric: must contain at least one non-digit
    if (!/[^0-9]/.test(ident)) {
      throw new TypeError('Prerelease identifier must contain at least one non-digit');
    }
    return { id: ident, next: end };
  }
}

/**
 * Parse build identifiers from a string starting at given index.
 * @param {string} str - The version string.
 * @param {number} start - Index after the leading '+'.
 * @returns {{ids:Array<string>, next:number}} - Array of build identifiers and position after last identifier.
 */
function parseBuildIdentifiers(str, start) {
  const ids = [];
  let pos = start;
  while (true) {
    const { id: buildId, next: idEnd } = parseBuildIdentifier(str, pos);
    ids.push(buildId);
    if (idEnd >= str.length) {
      break;
    }
    if (str.charAt(idEnd) !== '.') {
      throw new TypeError('Expected dot between build identifiers');
    }
    pos = idEnd + 1;
    if (pos >= str.length) {
      throw new TypeError('Empty build identifier');
    }
  }
  return { ids, next: idEnd };
}

/**
 * Parse a single build identifier.
 * @param {string} str - The version string.
 * @param {number} start - Index of first character of identifier.
 * @returns {{id:string, next:number}} - Identifier string and position after identifier.
 */
function parseBuildIdentifier(str, start) {
  if (start >= str.length) {
    throw new TypeError('Empty build identifier');
  }
  let end = start;
  while (end < str.length && str.charAt(end) !== '.' && str.charAt(end) !== '+') {
    end++;
  }
  const ident = str.slice(start, end);
  if (ident === '') {
    throw new TypeError('Empty build identifier');
  }
  // Build identifiers: ASCII alphanumeric and hyphen, leading zeros allowed
  if (!/^[0-9A-Za-z-]+$/.test(ident)) {
    throw new TypeError('Invalid build identifier');
  }
  return { id: ident, next: end };
}

/**
 * Check if a version string is valid according to SemVer 2.0.0.
 * @param {string} version - The version string to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
export function isValid(version) {
  try {
    parse(version);
    return true;
  } catch (e) {
    if (e instanceof TypeError) {
      return false;
    }
    throw e; // re-throw unexpected errors
  }
}

/**
 * Compare two semantic versions.
 * @param {string} a - First version string.
 * @param {string} b - Second version string.
 * @returns {-1|0|1} -1 if a < b, 1 if a > b, 0 if equal.
 * @throws {TypeError} If either version string is invalid.
 */
export function compare(a, b) {
  const va = parse(a);
  const vb = parse(b);

  // Compare major, minor, patch numerically
  if (va.major !== vb.major) {
    return va.major < vb.major ? -1 : 1;
  }
  if (va.minor !== vb.minor) {
    return va.minor < vb.minor ? -1 : 1;
  }
  if (va.patch !== vb.patch) {
    return va.patch < vb.patch ? -1 : 1;
  }

  // At this point, core version is equal; compare prerelease
  const pa = va.prerelease;
  const pb = vb.prerelease;

  // If both have no prerelease, they are equal
  if (pa.length === 0 && pb.length === 0) {
    return 0;
  }
  // A version without prerelease has higher precedence than one with
  if (pa.length === 0) {
    return 1; // a has no prerelease -> higher
  }
  if (pb.length === 0) {
    return -1; // b has no prerelease -> a lower
  }

  // Both have prerelease: compare identifier by identifier
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const left = pa[i];
    const right = pb[i];
    const leftNum = typeof left === 'number';
    const rightNum = typeof right === 'number';

    if (leftNum && rightNum) {
      if (left < right) return -1;
      if (left > right) return 1;
    } else if (!leftNum && !rightNum) {
      if (left < right) return -1;
      if (left > right) return 1;
    } else {
      // One numeric, one alphanumeric: numeric has lower precedence
      if (leftNum) return -1; // left numeric < right alphanumeric
      else return 1; // left alphanumeric > right numeric
    }
  }

  // All compared identifiers equal so far; the one with more identifiers has higher precedence
  if (pa.length === pb.length) {
    return 0;
  }
  return pa.length > pb.length ? 1 : -1;
}
