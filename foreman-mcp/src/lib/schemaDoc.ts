import { z } from "zod"

/**
 * Renders a Zod schema as a compact, human-readable shape string for MCP tool
 * descriptions — e.g. `{ t: 'W_FAIL'|'W_REJ'|…, u: string (≤200 chars), tok: number (≥0) }`.
 *
 * Why: `write_journal` and `write_ledger` validate `data` against per-operation
 * schemas that the tool's JSON inputSchema cannot express (the discriminator is
 * the sibling `operation` field). Agents were discovering the shapes one failed
 * call at a time (field feedback 2026-09 #1). Generating the description from the
 * same schema constants keeps the prose from drifting the way the hand-written
 * `set_verdict` line did (it omitted `inconclusive`).
 */

interface JsonSchemaNode {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  items?: JsonSchemaNode
  maxItems?: number
  minItems?: number
  maxLength?: number
  minLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}

export function renderShape(schema: z.ZodType): string {
  const node = z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchemaNode
  return renderNode(node)
}

function renderObject(node: JsonSchemaNode): string {
  const props = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const parts = Object.entries(props).map(
    ([key, child]) => `${key}${required.has(key) ? "" : "?"}: ${renderNode(child)}`
  )
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`
}

function renderNode(node: JsonSchemaNode): string {
  const variants = node.anyOf ?? node.oneOf
  if (variants) return variants.map(renderNode).join(" | ")
  if (node.enum) {
    return node.enum.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join("|")
  }
  if (node.const !== undefined) return JSON.stringify(node.const)

  const type = Array.isArray(node.type) ? node.type.join("|") : node.type
  if (type === "object") return renderObject(node)
  if (type === "array") {
    const item = node.items ? renderNode(node.items) : "any"
    const cap = node.maxItems !== undefined ? ` (max ${node.maxItems})` : ""
    return `${item}[]${cap}`
  }

  const constraints: string[] = []
  if (node.minLength !== undefined && node.minLength > 0) constraints.push(`≥${node.minLength} chars`)
  if (node.maxLength !== undefined) constraints.push(`≤${node.maxLength} chars`)
  if (node.minimum !== undefined) constraints.push(`≥${node.minimum}`)
  if (node.exclusiveMinimum !== undefined) constraints.push(`>${node.exclusiveMinimum}`)
  if (node.maximum !== undefined) constraints.push(`≤${node.maximum}`)
  if (node.exclusiveMaximum !== undefined) constraints.push(`<${node.exclusiveMaximum}`)
  const base = type ?? "any"
  return constraints.length ? `${base} (${constraints.join(", ")})` : base
}

/** Top-level property names of an object schema — used by the description-contract test. */
export function shapeKeys(schema: z.ZodType): string[] {
  const node = z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchemaNode
  return Object.keys(node.properties ?? {})
}
