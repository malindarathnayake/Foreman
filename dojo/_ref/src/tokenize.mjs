import { CalcError } from "./errors.mjs";

export function tokenize(input) {
  if (typeof input !== "string") throw new CalcError("PARSE", "input must be a string");
  const tokens = [];
  const isDigit = (c) => c >= "0" && c <= "9";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (isDigit(c)) {
      const start = i;
      while (i < input.length && isDigit(input[i])) i++;
      if (i < input.length && input[i] === ".") {
        i++;
        if (i >= input.length || !isDigit(input[i])) throw new CalcError("LEX", `malformed number at ${start}`);
        while (i < input.length && isDigit(input[i])) i++;
      }
      tokens.push({ type: "NUMBER", value: Number(input.slice(start, i)), op: null, pos: start });
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^") {
      tokens.push({ type: "OP", value: null, op: c, pos: i }); i++; continue;
    }
    if (c === "(") { tokens.push({ type: "LPAREN", value: null, op: null, pos: i }); i++; continue; }
    if (c === ")") { tokens.push({ type: "RPAREN", value: null, op: null, pos: i }); i++; continue; }
    throw new CalcError("LEX", `invalid character '${c}' at ${i}`);
  }
  tokens.push({ type: "EOF", value: null, op: null, pos: input.length });
  return tokens;
}
