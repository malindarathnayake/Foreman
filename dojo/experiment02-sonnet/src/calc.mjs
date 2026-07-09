import { CalcError } from "./errors.mjs";
import { tokenize } from "./tokenize.mjs";
import { parse } from "./parse.mjs";
import { evaluate } from "./evaluate.mjs";

export { CalcError };

export function calc(input) {
  return evaluate(parse(tokenize(input)));
}
