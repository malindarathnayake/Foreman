import { CalcError } from "./errors.mjs";

export function evaluate(node) {
  switch (node.type) {
    case "num":
      return node.value;
    case "unary":
      if (node.op === "-") {
        return -evaluate(node.operand);
      }
      throw new CalcError("BADOP", `Unknown unary operator: ${node.op}`);
    case "binary": {
      const left = evaluate(node.left);
      switch (node.op) {
        case "+":
          return left + evaluate(node.right);
        case "-":
          return left - evaluate(node.right);
        case "*":
          return left * evaluate(node.right);
        case "/": {
          const right = evaluate(node.right);
          if (right === 0) {
            throw new CalcError("DIVZERO", "Division by zero");
          }
          return left / right;
        }
        case "^":
          return Math.pow(left, evaluate(node.right));
        default:
          throw new CalcError("BADOP", `Unknown binary operator: ${node.op}`);
      }
    }
    default:
      throw new CalcError("BADNODE", `Unknown node type: ${node.type}`);
  }
}
