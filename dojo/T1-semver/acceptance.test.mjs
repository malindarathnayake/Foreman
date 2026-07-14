// GROUND TRUTH — never shown to a worker.
// Scores an arm's semver.mjs against the T1 spec. Emits JSON on stdout; exits 0 always.
// Usage: DOJO_MODULE=<abs path to arm semver.mjs> node acceptance.test.mjs
import { pathToFileURL } from "node:url";

const modPath = process.env.DOJO_MODULE;
if (!modPath) {
  console.log(JSON.stringify({ error: "DOJO_MODULE not set" }));
  process.exit(0);
}

let mod;
try {
  mod = await import(pathToFileURL(modPath).href);
} catch (e) {
  console.log(JSON.stringify({ error: "import failed", detail: String(e).slice(0, 300), total: 0, passed: 0 }));
  process.exit(0);
}

const cases = []; // {cat, name, fn}
const add = (cat, name, fn) => cases.push({ cat, name, fn });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- parse: valid ----
const P = (v) => mod.parse(v);
const shape = (o) => ({ major: o.major, minor: o.minor, patch: o.patch, prerelease: o.prerelease, build: o.build });
add("parse_valid", "basic", () => eq(shape(P("1.2.3")), { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }));
add("parse_valid", "v-prefix", () => eq(shape(P("v2.0.0")), { major: 2, minor: 0, patch: 0, prerelease: [], build: [] }));
add("parse_valid", "zeros", () => eq(shape(P("0.0.0")), { major: 0, minor: 0, patch: 0, prerelease: [], build: [] }));
add("parse_valid", "pre-alpha", () => eq(P("1.2.3-alpha").prerelease, ["alpha"]));
add("parse_valid", "pre-alpha.1-numeric", () => eq(P("1.2.3-alpha.1").prerelease, ["alpha", 1]));
add("parse_valid", "pre-all-numeric", () => eq(P("1.2.3-0.3.7").prerelease, [0, 3, 7]));
add("parse_valid", "pre-mixed", () => eq(P("1.2.3-x.7.z.92").prerelease, ["x", 7, "z", 92]));
add("parse_valid", "build", () => eq(P("1.2.3+build.1").build, ["build", "1"]));
add("parse_valid", "build-leading-zero-ok", () => eq(P("1.2.3+001").build, ["001"]));
add("parse_valid", "pre+build", () => {
  const r = P("1.0.0-beta+exp.sha.5114f85");
  return eq(r.prerelease, ["beta"]) && eq(r.build, ["exp", "sha", "5114f85"]);
});
add("parse_valid", "rc-numeric-type", () => typeof P("1.0.0-rc.1").prerelease[1] === "number");

// ---- parse: invalid (must throw) ----
const throws = (v) => { try { mod.parse(v); return false; } catch { return true; } };
add("parse_invalid", "missing-patch", () => throws("1.2"));
add("parse_invalid", "too-many-parts", () => throws("1.2.3.4"));
add("parse_invalid", "leading-zero-major", () => throws("01.2.3"));
add("parse_invalid", "leading-zero-pre-numeric", () => throws("1.2.3-01"));
add("parse_invalid", "empty-pre", () => throws("1.2.3-"));
add("parse_invalid", "empty-build", () => throws("1.2.3+"));
add("parse_invalid", "empty-string", () => throws(""));
add("parse_invalid", "alpha-parts", () => throws("a.b.c"));
add("parse_invalid", "negative", () => throws("1.2.-3"));
add("parse_invalid", "bad-pre-char", () => throws("1.2.3-beta_1"));
add("parse_invalid", "non-string-number", () => throws(123));
add("parse_invalid", "non-string-null", () => throws(null));

// ---- isValid ----
add("isValid", "true-basic", () => mod.isValid("1.2.3") === true);
add("isValid", "true-pre", () => mod.isValid("1.0.0-rc.1+b") === true);
add("isValid", "false-bad", () => mod.isValid("1.2") === false);
add("isValid", "false-null-no-throw", () => mod.isValid(null) === false);

// ---- compare ----
const C = (a, b) => mod.compare(a, b);
add("compare", "major", () => C("1.0.0", "2.0.0") === -1);
add("compare", "major-rev", () => C("2.0.0", "1.0.0") === 1);
add("compare", "equal", () => C("1.0.0", "1.0.0") === 0);
add("compare", "minor", () => C("1.0.0", "1.1.0") === -1);
add("compare", "patch", () => C("1.0.1", "1.0.0") === 1);
add("compare", "pre-lt-release", () => C("1.0.0-alpha", "1.0.0") === -1);
add("compare", "release-gt-pre", () => C("1.0.0", "1.0.0-alpha") === 1);
add("compare", "field-count", () => C("1.0.0-alpha", "1.0.0-alpha.1") === -1);
add("compare", "numeric-lt-alnum", () => C("1.0.0-alpha.1", "1.0.0-alpha.beta") === -1);
add("compare", "lexical-alpha-beta", () => C("1.0.0-alpha.beta", "1.0.0-beta") === -1);
add("compare", "beta-lt-beta.2", () => C("1.0.0-beta", "1.0.0-beta.2") === -1);
add("compare", "numeric-2-lt-11", () => C("1.0.0-beta.2", "1.0.0-beta.11") === -1);
add("compare", "beta.11-lt-rc.1", () => C("1.0.0-beta.11", "1.0.0-rc.1") === -1);
add("compare", "rc-lt-release", () => C("1.0.0-rc.1", "1.0.0") === -1);
add("compare", "build-ignored-eq", () => C("1.0.0+build1", "1.0.0+build2") === 0);
add("compare", "build-vs-none-eq", () => C("1.0.0+a", "1.0.0") === 0);
add("compare", "v-prefix-eq", () => C("v1.0.0", "1.0.0") === 0);
add("compare", "invalid-throws", () => { try { C("1.0", "1.0.0"); return false; } catch { return true; } });
add("compare", "full-chain", () => {
  const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
    "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < chain.length - 1; i++) if (C(chain[i], chain[i + 1]) !== -1) return false;
  return true;
});

const byCat = {};
const failures = [];
let passed = 0;
for (const c of cases) {
  let ok = false;
  try { ok = c.fn() === true; } catch { ok = false; }
  byCat[c.cat] ??= { total: 0, passed: 0 };
  byCat[c.cat].total++;
  if (ok) { passed++; byCat[c.cat].passed++; } else failures.push(`${c.cat}/${c.name}`);
}
console.log(JSON.stringify({ total: cases.length, passed, failed: cases.length - passed, byCat, failures }, null, 2));
process.exit(0);
