import { CalcError } from "./errors.mjs";

export function parse(tokens) {
  let pos = 0;
  let depth = 0;

  function peek() {
    return tokens[pos];
  }

  function advance() {
    return tokens[pos++];
  }

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const tok = peek();
      if (tok.type === "OP" && (tok.op === "+" || tok.op === "-")) {
        advance();
        const right = parseTerm();
        left = { type: "binary", op: tok.op, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    for (;;) {
      const tok = peek();
      if (tok.type === "OP" && (tok.op === "*" || tok.op === "/")) {
        advance();
        const right = parseFactor();
        left = { type: "binary", op: tok.op, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  function parseFactor() {
    const tok = peek();
    if (tok.type === "OP" && tok.op === "-") {
      advance();
      const operand = parseFactor();
      return { type: "unary", op: "-", operand };
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    const tok = peek();
    if (tok.type === "OP" && tok.op === "^") {
      advance();
      const exponent = parseFactor();
      return { type: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  function parsePrimary() {
    const tok = peek();

    if (tok.type === "NUMBER") {
      advance();
      return { type: "num", value: tok.value };
    }

    if (tok.type === "LPAREN") {
      advance();
      depth++;
      if (depth > 50) {
        throw new CalcError(
          "DEPTH",
          `Maximum parenthesis nesting depth exceeded at position ${tok.pos}`
        );
      }
      const node = parseExpr();
      const closing = peek();
      if (closing.type !== "RPAREN") {
        throw new CalcError(
          "PARSE",
          `Expected ')' at position ${closing.pos}`
        );
      }
      advance();
      depth--;
      return node;
    }

    throw new CalcError(
      "PARSE",
      `Unexpected token '${tok.type}' at position ${tok.pos}`
    );
  }

  if (
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    (tokens.length === 1 && tokens[0].type === "EOF")
  ) {
    throw new CalcError("PARSE", "Empty input");
  }

  const ast = parseExpr();

  const remaining = peek();
  if (!remaining || remaining.type !== "EOF") {
    throw new CalcError(
      "PARSE",
      `Unexpected token '${remaining ? remaining.type : "EOF"}' at position ${
        remaining ? remaining.pos : "end"
      }`
    );
  }

  return ast;
}
