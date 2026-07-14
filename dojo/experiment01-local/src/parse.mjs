// U2 — implement parse(tokens) per spec.md. Import CalcError from ./errors.mjs.
// Node = {type:'num',value} | {type:'binary',op,left,right} | {type:'unary',op:'-',operand}
import { CalcError } from "./errors.mjs";

export function parse(tokens) {
  if (tokens.length === 0 || tokens[0].type === 'EOF') {
    throw new CalcError("PARSE", "empty input");
  }

  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const consume = (expectedType, expectedValue) => {
    const tok = peek();
    if (tok.type !== expectedType) {
      throw new CalcError("PARSE", `expected ${expectedType} got ${tok.type}`);
    }
    if (expectedValue !== undefined && tok.op !== expectedValue) {
      throw new CalcError("PARSE", `expected op ${expectedValue} got ${tok.op}`);
    }
    pos++;
    return tok;
  };

  const expr = () => {
    let node = term();
    while (peek().type === 'OP' && (peek().op === '+' || peek().op === '-')) {
      const op = peek().op;
      consume('OP');
      const right = term();
      node = { type: 'binary', op, left: node, right: right };
    }
    return node;
  };

  const term = () => {
    let node = factor();
    while (peek().type === 'OP' && (peek().op === '*' || peek().op === '/')) {
      const op = peek().op;
      consume('OP');
      const right = factor();
      node = { type: 'binary', op, left: node, right: right };
    }
    return node;
  };

  const factor = () => {
    if (peek().type === 'OP' && peek().op === '-') {
      consume('OP');
      const operand = factor();
      return { type: 'unary', op: '-', operand };
    }
    return power();
  };

  const power = () => {
    let node = primary();
    if (peek().type === 'OP' && peek().op === '^') {
      consume('OP');
      const rhs = factor(); // right-associative: RHS is factor
      node = { type: 'binary', op: '^', left: node, right: rhs };
    }
    return node;
  };

  const primary = () => {
    const tok = peek();
    if (tok.type === 'NUMBER') {
      consume('NUMBER');
      return { type: 'num', value: tok.value };
    }
    if (tok.type === 'LPAREN') {
      consume('LPAREN');
      depth++;
      if (depth > 50) {
        throw new CalcError("DEPTH", "Parenthesis nesting depth exceeds 50");
      }
      const inner = expr();
      if (peek().type !== 'RPAREN') {
        throw new CalcError("PARSE", "Missing closing parenthesis");
      }
      consume('RPAREN');
      depth--;
      return inner;
    }
    throw new CalcError("PARSE", `Unexpected token ${JSON.stringify(tok)}`);
  };

  const ast = expr();
  if (peek().type !== 'EOF') {
    throw new CalcError("PARSE", "Extra tokens after expression");
  }
  return ast;
}
