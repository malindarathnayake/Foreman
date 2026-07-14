import { CalcError } from "./errors.mjs";

export function evaluate(node) {
  if (node.type === "num") return node.value;
  if (node.type === "unary") return -evaluate(node.operand);
  if (node.type === "binary") {
    const l = evaluate(node.left);
    const r = evaluate(node.right);
    switch (node.op) {
      case "+": return l + r;
      case "-": return l - r;
      case "*": return l * r;
      case "/":
        if (r === 0) throw new CalcError("DIVZERO", "division by zero");
        return l / r;
      case "^": return Math.pow(l, r);
    }
  }
  throw new CalcError("PARSE", "unknown node");
}
