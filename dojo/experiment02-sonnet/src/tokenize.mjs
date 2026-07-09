import { CalcError } from "./errors.mjs";

const NUMBER_RE = /^\d+(\.\d+)?/;

export function tokenize(input) {
  if (typeof input !== "string") {
    throw new CalcError("PARSE", "tokenize expects a string input");
  }

  const tokens = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      const match = NUMBER_RE.exec(input.slice(i));
      const text = match[0];
      tokens.push({ type: "NUMBER", value: Number(text), op: null, pos: i });
      i += text.length;
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^") {
      tokens.push({ type: "OP", value: null, op: ch, pos: i });
      i++;
      continue;
    }

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

    throw new CalcError("LEX", `Unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ type: "EOF", value: null, op: null, pos: len });

  return tokens;
}
