import { z } from "zod"
import { renderShape } from "./schemaDoc.js"

/**
 * Turns a ZodError from a write tool into one line per field plus the expected data
 * shape for the operation that was attempted.
 *
 * Why: the raw ZodError message is a JSON issue dump. A pit-boss reading it spent
 * three round trips learning that `via` is an enum, `severity` is lowercase, `line` is
 * a string, and `msg` is capped at 400 (field feedback 2026-09 round 2). The shape is
 * rendered from the same schema constants the descriptions use, so the hint can never
 * disagree with what the validator enforces.
 */
const MAX_ISSUES = 12

export function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError
}

export function formatSchemaError(
  tool: string,
  err: z.ZodError,
  input: unknown,
  shapes: Record<string, z.ZodType>
): string {
  const op =
    typeof input === "object" && input !== null && "operation" in input
      ? String((input as { operation: unknown }).operation)
      : undefined

  const issues = err.issues
  const shown = issues.slice(0, MAX_ISSUES).map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join(".") : "(root)"
    return `  ${where}: ${issue.message}`
  })
  const header =
    `SCHEMA ERROR — ${tool}${op ? ` ${op}` : ""} rejected ` +
    `(${issues.length} issue${issues.length === 1 ? "" : "s"}):`
  const lines = [header, ...shown]
  if (issues.length > MAX_ISSUES) lines.push(`  … +${issues.length - MAX_ISSUES} more`)

  const shape = op !== undefined ? shapes[op] : undefined
  if (shape) {
    lines.push(`Expected data shape: ${renderShape(shape)}`)
  } else {
    lines.push(`Operations: ${Object.keys(shapes).join(", ")}`)
  }
  return lines.join("\n")
}
