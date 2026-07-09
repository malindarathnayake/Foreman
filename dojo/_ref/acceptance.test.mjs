// GROUND TRUTH — never shown to a worker. Scores ./src against the expr spec.
// Emits JSON on stdout; exits 0 always. Each category is self-contained so units
// can be gated independently (parse uses hand-built tokens; evaluate hand-built nodes).
import { tokenize } from "./src/tokenize.mjs";
import { parse } from "./src/parse.mjs";
import { evaluate } from "./src/evaluate.mjs";
import { calc, CalcError } from "./src/calc.mjs";

const cases = [];
const add = (cat, name, fn) => cases.push({ cat, name, fn });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return !!e && e.code === code; } };

// token builders (frozen contract shape)
const N = (value, pos) => ({ type: "NUMBER", value, op: null, pos });
const O = (op, pos) => ({ type: "OP", value: null, op, pos });
const LP = (pos) => ({ type: "LPAREN", value: null, op: null, pos });
const RP = (pos) => ({ type: "RPAREN", value: null, op: null, pos });
const EOF = (pos) => ({ type: "EOF", value: null, op: null, pos });
// node builders
const num = (value) => ({ type: "num", value });
const bin = (op, left, right) => ({ type: "binary", op, left, right });
const neg = (operand) => ({ type: "unary", op: "-", operand });

// ---- tokenize (string -> Token[]) ----
add("tokenize", "simple", () => eq(tokenize("1+2"), [N(1, 0), O("+", 1), N(2, 2), EOF(3)]));
add("tokenize", "whitespace+multidigit", () => eq(tokenize("12 * 3"), [N(12, 0), O("*", 3), N(3, 5), EOF(6)]));
add("tokenize", "float", () => eq(tokenize("3.14"), [N(3.14, 0), EOF(4)]));
add("tokenize", "parens", () => eq(tokenize("(1)"), [LP(0), N(1, 1), RP(2), EOF(3)]));
add("tokenize", "caret", () => eq(tokenize("2^3"), [N(2, 0), O("^", 1), N(3, 2), EOF(3)]));
add("tokenize", "leading-trailing-ws", () => eq(tokenize(" 1 "), [N(1, 1), EOF(3)]));
add("tokenize", "minus", () => eq(tokenize("10-4"), [N(10, 0), O("-", 2), N(4, 3), EOF(4)]));
add("tokenize", "empty-is-eof", () => eq(tokenize(""), [EOF(0)]));
add("tokenize", "bad-char-letter", () => throwsCode(() => tokenize("1+a"), "LEX"));
add("tokenize", "bad-char-at", () => throwsCode(() => tokenize("1 @ 2"), "LEX"));

// ---- parse (Token[] -> Node) — hand-built tokens, independent of tokenize ----
add("parse", "add", () => eq(parse([N(1, 0), O("+", 1), N(2, 2), EOF(3)]), bin("+", num(1), num(2))));
add("parse", "prec-mul-then-add", () => eq(parse([N(2, 0), O("*", 1), N(3, 2), O("+", 3), N(4, 4), EOF(5)]), bin("+", bin("*", num(2), num(3)), num(4))));
add("parse", "prec-add-then-mul", () => eq(parse([N(2, 0), O("+", 1), N(3, 2), O("*", 3), N(4, 4), EOF(5)]), bin("+", num(2), bin("*", num(3), num(4)))));
add("parse", "left-assoc-sub", () => eq(parse([N(2, 0), O("-", 1), N(3, 2), O("-", 3), N(4, 4), EOF(5)]), bin("-", bin("-", num(2), num(3)), num(4))));
add("parse", "unary-minus", () => eq(parse([O("-", 0), N(2, 1), EOF(2)]), neg(num(2))));
add("parse", "unary-tighter-than-caret", () => eq(parse([O("-", 0), N(2, 1), O("^", 2), N(2, 3), EOF(4)]), neg(bin("^", num(2), num(2)))));
add("parse", "caret-right-assoc", () => eq(parse([N(2, 0), O("^", 1), N(3, 2), O("^", 3), N(2, 4), EOF(5)]), bin("^", num(2), bin("^", num(3), num(2)))));
add("parse", "parens", () => eq(parse([LP(0), N(1, 1), O("+", 2), N(2, 3), RP(4), O("*", 5), N(3, 6), EOF(7)]), bin("*", bin("+", num(1), num(2)), num(3))));
add("parse", "unbalanced", () => throwsCode(() => parse([LP(0), N(1, 1), O("+", 2), N(2, 3), EOF(4)]), "PARSE"));
add("parse", "trailing-tokens", () => throwsCode(() => parse([N(1, 0), N(2, 2), EOF(3)]), "PARSE"));
add("parse", "empty", () => throwsCode(() => parse([EOF(0)]), "PARSE"));
add("parse", "missing-operand", () => throwsCode(() => parse([N(1, 0), O("+", 1), EOF(2)]), "PARSE"));

// ---- evaluate (Node -> number) — hand-built nodes, independent of parse ----
add("evaluate", "add", () => evaluate(bin("+", num(1), num(2))) === 3);
add("evaluate", "sub", () => evaluate(bin("-", num(10), num(3))) === 7);
add("evaluate", "mul", () => evaluate(bin("*", num(3), num(4))) === 12);
add("evaluate", "div", () => evaluate(bin("/", num(10), num(4))) === 2.5);
add("evaluate", "unary", () => evaluate(neg(num(5))) === -5);
add("evaluate", "pow", () => evaluate(bin("^", num(2), num(10))) === 1024);
add("evaluate", "pow-zero", () => evaluate(bin("^", num(2), num(0))) === 1);
add("evaluate", "nested", () => evaluate(bin("+", bin("*", num(2), num(3)), num(4))) === 10);
add("evaluate", "unary-pow", () => evaluate(neg(bin("^", num(2), num(2)))) === -4);
add("evaluate", "div-by-zero", () => throwsCode(() => evaluate(bin("/", num(1), num(0))), "DIVZERO"));

// ---- calc (string -> number) — full integration + error codes ----
add("calc", "prec", () => calc("1+2*3") === 7);
add("calc", "parens", () => calc("(1+2)*3") === 9);
add("calc", "pow-right-assoc", () => calc("2^3^2") === 512);
add("calc", "unary-pow", () => calc("-2^2") === -4);
add("calc", "pow-neg-exp", () => calc("2^-2") === 0.25);
add("calc", "div", () => calc("10/4") === 2.5);
add("calc", "whitespace", () => calc("  3 + 4 ") === 7);
add("calc", "double-parens", () => calc("((1))") === 1);
add("calc", "float-mul", () => calc("3.5*2") === 7);
add("calc", "left-assoc-div", () => calc("8/4/2") === 1);
add("calc", "sub-add-chain", () => calc("2+3-4") === 1);
add("calc", "div-zero-code", () => throwsCode(() => calc("1/0"), "DIVZERO"));
add("calc", "parse-err-code", () => throwsCode(() => calc("1+"), "PARSE"));
add("calc", "lex-err-code", () => throwsCode(() => calc("1+a"), "LEX"));
add("calc", "empty-code", () => throwsCode(() => calc(""), "PARSE"));
add("calc", "nonstring-code", () => throwsCode(() => calc(42), "PARSE"));
add("calc", "depth-guard", () => throwsCode(() => calc("(".repeat(60) + "1" + ")".repeat(60)), "DEPTH"));
add("calc", "shallow-parens-ok", () => calc("(".repeat(10) + "1" + ")".repeat(10)) === 1);

// ---- errors (typed contract) ----
add("errors", "is-error", () => new CalcError("LEX", "x") instanceof Error);
add("errors", "has-code", () => new CalcError("DEPTH", "x").code === "DEPTH");
add("errors", "divzero-instance", () => { try { calc("1/0"); return false; } catch (e) { return e instanceof CalcError; } });

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
