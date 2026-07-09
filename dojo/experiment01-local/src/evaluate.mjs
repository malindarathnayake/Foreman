import { CalcError } from "./errors.mjs";

export function evaluate(node) {
  switch (node.type) {
    case "num":
      return node.value;
    case "unary":
      return -evaluate(node.operand);
    case "binary": {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) {
            throw new CalcError("DIVZERO", "Division by zero");
          }
          return left / right;
        case "^":
          return Math.pow(left, right);
        default:
          throw new CalcError("PARSE", `Unknown operator ${node.op}`);
      }
    }
    default:
      throw new CalcError("PARSE", `Unknown node type ${node.type}`);
  }
}
