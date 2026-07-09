// U4 — implement calc(input) per spec.md: evaluate(parse(tokenize(input))).
// Re-export CalcError so callers import both from here. Import the 3 stages.
import { CalcError } from "./errors.mjs";
import { tokenize } from "./tokenize.mjs";
import { parse } from "./parse.mjs";
import { evaluate } from "./evaluate.mjs";

export { CalcError };

export function calc(input) {
  throw new CalcError("PARSE", "not implemented");
}
