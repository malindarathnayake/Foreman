// U2 — implement parse(tokens) per spec.md. Import CalcError from ./errors.mjs.
// Node = {type:'num',value} | {type:'binary',op,left,right} | {type:'unary',op:'-',operand}
import { CalcError } from "./errors.mjs";

export function parse(tokens) {
  throw new CalcError("PARSE", "not implemented");
}
