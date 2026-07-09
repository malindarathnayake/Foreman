import { CalcError } from "./errors.mjs";

const MAX_DEPTH = 50;

export function parse(tokens) {
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let node = parseTerm();
    while (peek().type === "OP" && (peek().op === "+" || peek().op === "-")) {
      const op = next().op;
      node = { type: "binary", op, left: node, right: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek().type === "OP" && (peek().op === "*" || peek().op === "/")) {
      const op = next().op;
      node = { type: "binary", op, left: node, right: parseFactor() };
    }
    return node;
  }
  function parseFactor() {
    if (peek().type === "OP" && peek().op === "-") {
      next();
      return { type: "unary", op: "-", operand: parseFactor() };
    }
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (peek().type === "OP" && peek().op === "^") {
      next();
      const exp = parseFactor();
      return { type: "binary", op: "^", left: base, right: exp };
    }
    return base;
  }
  function parsePrimary() {
    const t = peek();
    if (t.type === "NUMBER") { next(); return { type: "num", value: t.value }; }
    if (t.type === "LPAREN") {
      depth++;
      if (depth > MAX_DEPTH) throw new CalcError("DEPTH", "expression nesting too deep");
      next();
      const node = parseExpr();
      if (peek().type !== "RPAREN") throw new CalcError("PARSE", `expected ) at ${peek().pos}`);
      next();
      depth--;
      return node;
    }
    throw new CalcError("PARSE", `unexpected ${t.type} at ${t.pos}`);
  }

  if (peek().type === "EOF") throw new CalcError("PARSE", "empty expression");
  const node = parseExpr();
  if (peek().type !== "EOF") throw new CalcError("PARSE", `unexpected trailing ${peek().type} at ${peek().pos}`);
  return node;
}
