/**
 * contract_probe (0.6.21). Field report 2026-09-10: the only unit that passed first time
 * was the one probed live before its brief was written; a silent 200-with-zero-rows and an
 * ALPN bug that survived 94.6% coverage and six killed mutations were found by one real
 * request. The Probe check made this a rule in prose; this makes it a receipt.
 *
 * Per Codex review (2026-09-10) the probe is SERVER-EXECUTED with explicit assertions, not
 * a caller-supplied observation: Foreman sends the request itself (GET or HEAD only, so it
 * is side-effect-free by construction), resolves credentials from environment variable
 * NAMES that are never echoed, and records what it asserted and what it saw. A probe that
 * fails its assertions is recorded as failed and never satisfies the requirement. What it
 * proves: this target answered this request with this status and these bytes at this time,
 * through Foreman's HTTP client. It does not prove the application's own transport path.
 */
import { createHash } from "crypto"
import { z } from "zod"
import { recordProbe, type ProbeRecord } from "../lib/ledger.js"
import { toKeyValue } from "../lib/toon.js"

export const ContractProbeInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  url: z.string().url().max(4096),
  /** Header values may be literal or `${ENV:NAME}`; the resolved value is never printed or stored. */
  headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
  expect: z.object({
    status: z.number().int().min(100).max(599).optional(),
    min_bytes: z.number().int().min(0).optional(),
    /** Dot path into a JSON body that must be a non-empty array, a non-empty object, or a non-null scalar. */
    json_nonempty_path: z.string().max(400).optional(),
    /** A substring the body must contain. */
    contains: z.string().min(1).max(400).optional(),
  }).default({}),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
})
export type ContractProbeInput = z.infer<typeof ContractProbeInputSchema>

const MAX_BODY = 4 * 1024 * 1024

/** Resolve every `${ENV:NAME}` token in a header value ("Bearer ${ENV:TOKEN}" included). */
function resolveHeader(value: string): { value: string; fromEnv: string[]; missing: string | null } {
  const fromEnv: string[] = []
  let missing: string | null = null
  const resolved = value.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (_m, name: string) => {
    fromEnv.push(name)
    const v = process.env[name]
    if (v === undefined || v === "") { missing ??= name; return "" }
    return v
  })
  return { value: resolved, fromEnv, missing }
}

function jsonPath(body: string, dotPath: string): unknown {
  let node: unknown
  try {
    node = JSON.parse(body)
  } catch {
    return undefined
  }
  for (const key of dotPath.split(".").filter(Boolean)) {
    if (node === null || typeof node !== "object") return undefined
    node = Array.isArray(node) && /^\d+$/.test(key) ? node[Number(key)] : (node as Record<string, unknown>)[key]
  }
  return node
}

export function evaluate(input: ContractProbeInput, status: number, body: string): string[] {
  const failed: string[] = []
  if (input.expect.status !== undefined ? status !== input.expect.status : status < 200 || status > 299) {
    failed.push(`status ${status}${input.expect.status !== undefined ? ` (expected ${input.expect.status})` : " (expected 2xx)"}`)
  }
  const bytes = Buffer.byteLength(body, "utf-8")
  if (input.expect.min_bytes !== undefined && bytes < input.expect.min_bytes) failed.push(`body ${bytes} bytes (expected at least ${input.expect.min_bytes})`)
  if (input.expect.contains !== undefined && !body.includes(input.expect.contains)) failed.push(`body does not contain ${JSON.stringify(input.expect.contains)}`)
  if (input.expect.json_nonempty_path !== undefined) {
    const v = jsonPath(body, input.expect.json_nonempty_path)
    const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
    if (empty) failed.push(`json path ${input.expect.json_nonempty_path} is empty or absent (a 200 with no rows is the silent failure this check exists for)`)
  }
  return failed
}

export async function contractProbe(raw: ContractProbeInput, ledgerPath: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const input = ContractProbeInputSchema.parse(raw)
  const url = new URL(input.url)
  const target = `${url.origin}${url.pathname}`   // the query may carry ids or tokens; the record keeps origin + path only
  const headers: Record<string, string> = {}
  const envNames: string[] = []
  for (const [k, v] of Object.entries(input.headers)) {
    const r = resolveHeader(v)
    if (r.missing) {
      return toKeyValue({ status: "error", error: "credential_missing", env: r.missing, hint: `set ${r.missing} in the server environment; the value is never printed or stored` })
    }
    envNames.push(...r.fromEnv)
    headers[k] = r.value
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeout_ms)
  let status = 0
  let body = ""
  let transport: string | null = null
  try {
    const res = await fetchImpl(url, { method: input.method, headers, signal: controller.signal, redirect: "manual" })
    status = res.status
    if (input.method === "GET") {
      const text = await res.text()
      body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text
    }
  } catch (err) {
    transport = err instanceof Error ? (err.name === "AbortError" ? `timed out after ${input.timeout_ms} ms` : err.message) : String(err)
  } finally {
    clearTimeout(timer)
  }
  const failed = transport !== null ? [`transport: ${transport}`] : evaluate(input, status, body)
  const record: ProbeRecord = {
    ts: new Date().toISOString(),
    method: input.method,
    target,
    status: transport !== null ? null : status,
    bytes: Buffer.byteLength(body, "utf-8"),
    sha256: createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16),
    asserted: Object.entries(input.expect).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`),
    passed: failed.length === 0,
    ...(failed.length ? { failed } : {}),
    ...(envNames.length ? { credentials: envNames } : {}),
  }
  let ledgerNote = ""
  try {
    await recordProbe(ledgerPath, input.phase, input.unit_id, record)
  } catch (err) {
    ledgerNote = err instanceof Error ? err.message : String(err)
  }
  return toKeyValue({
    status: record.passed ? "pass" : "fail",
    phase: input.phase,
    unit_id: input.unit_id,
    method: input.method,
    target,
    http_status: record.status ?? "n/a",
    bytes: record.bytes,
    body_sha256: record.sha256,
    asserted: record.asserted.join(",") || "2xx",
    failed: failed.join("; ") || "none",
    credentials_from_env: envNames.join(",") || "none",
    recorded: ledgerNote ? `no (${ledgerNote})` : "yes (unit.probes)",
    note: "Executed by Foreman's HTTP client, GET/HEAD only. Proves this target answered this request now; it does not prove the application's own transport path. A failed probe never satisfies the contract requirement.",
  })
}
