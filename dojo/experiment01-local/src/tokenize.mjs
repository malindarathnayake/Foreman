// U1 — implement tokenize(input) per spec.md. Import CalcError from ./errors.mjs.
// Token = { type:'NUMBER'|'OP'|'LPAREN'|'RPAREN'|'EOF', value:number|null, op:string|null, pos:number }
import { CalcError } from "./errors.mjs";

export function tokenize(input) {
  throw new CalcError("PARSE", "not implemented");
}
