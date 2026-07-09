// U1 — implement tokenize(input) per spec.md. Import CalcError from ./errors.mjs.
// Token = { type:'NUMBER'|'OP'|'LPAREN'|'RPAREN'|'EOF', value:number|null, op:string|null, pos:number }
import { CalcError } from "./errors.mjs";

export function tokenize(input) {
  if (typeof input !== "string") {
    throw new CalcError("PARSE", "input must be a string");
  }

  const tokens = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Skip whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      const start = i;
      // match digits
      let j = i;
      while (j < len && /[0-9]/.test(input[j])) {
        j++;
      }
      // optional fractional part
      if (j < len && input[j] === ".") {
        const dotPos = j;
        j++; // skip dot
        if (j < len && /[0-9]/.test(input[j])) {
          while (j < len && /[0-9]/.test(input[j])) {
            j++;
          }
        } else {
          // dot not followed by digit -> invalid number
          throw new CalcError("LEX", `Invalid number at position ${start}`);
        }
      }
      const numStr = input.slice(start, j);
      const value = Number(numStr);
      tokens.push({ type: "NUMBER", value, op: null, pos: start });
      i = j;
      continue;
    }

    // Operator
    if ("+-*/^".includes(ch)) {
      tokens.push({ type: "OP", value: null, op: ch, pos: i });
      i++;
      continue;
    }

    // Parentheses
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: null, op: null, pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: null, op: null, pos: i });
      i++;
      continue;
    }

    // Any other character is illegal
    throw new CalcError("LEX", `Unexpected character at position ${i}`);
  }

  // EOF token
  tokens.push({ type: "EOF", value: null, op: null, pos: len });
  return tokens;
}
