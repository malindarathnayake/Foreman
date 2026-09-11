/**
 * contract_probe (0.6.21; claim-bound and streaming since 0.6.22, architecture council
 * 2026-09-10). Foreman sends a GET or HEAD itself, resolves header values from environment
 * variable NAMES it never prints, evaluates explicit assertions and records the result on
 * the unit.
 *
 * Two modes. CLAIM mode takes `{ phase, unit_id, claim_id }` and loads the request recipe
 * and assertions from the claim registered in the spec's foreman-contract block; the
 * caller supplies no URL and no assertion, so a probe cannot be aimed at an unrelated
 * endpoint and labelled with a claim it did not test. Only claim-mode records satisfy the
 * preflight requirement. DIAGNOSTIC mode takes a url and assertions for exploration; its
 * record is marked diagnostic and never satisfies a claim.
 *
 * Capture streams with a byte cap: an over-cap body aborts the read, the record says
 * capture_complete:false, and no assertion can pass against a prefix.
 */
import { createHash } from "crypto"
import path from "path"
import { z } from "zod"
import { recordProbe, type ProbeRecord } from "../lib/ledger.js"
import { ClaimAssertionsSchema, unitContract, type ClaimAssertions } from "../lib/specContract.js"
import { resolveNamedCredentials } from "../lib/foremanEnv.js"
import { toKeyValue } from "../lib/toon.js"

export const ContractProbeInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  /** Claim mode: the request and assertions come from the spec. */
  claim_id: z.string().min(1).max(64).optional(),
  /** Diagnostic mode only. */
  method: z.enum(["GET", "HEAD"]).default("GET"),
  url: z.string().url().max(4096).optional(),
  headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
  expect: ClaimAssertionsSchema.default({}),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
})
export type ContractProbeInput = z.infer<typeof ContractProbeInputSchema>

export const MAX_CAPTURE = 4 * 1024 * 1024

const ENV_TOKEN = /\$\{ENV:([A-Z0-9_]+)\}/g

/** Every `${ENV:NAME}` name a header value references ("Bearer ${ENV:TOKEN}" included). */
function envNamesIn(value: string): string[] {
  return [...value.matchAll(ENV_TOKEN)].map((m) => m[1])
}

export interface ContractProbeOptions {
  /** Override for `~/.foreman-mcp/.env`. Test seam. */
  credentialsPath?: string
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

/** Every failed assertion, in prose. An incomplete capture fails every body assertion by construction. */
export function evaluate(expect: ClaimAssertions, status: number, body: string, captureComplete = true): string[] {
  const failed: string[] = []
  if (expect.status !== undefined ? status !== expect.status : status < 200 || status > 299) {
    failed.push(`status ${status}${expect.status !== undefined ? ` (expected ${expect.status})` : " (expected 2xx)"}`)
  }
  const bodyChecks = expect.min_bytes !== undefined || expect.contains !== undefined || expect.json_nonempty_path !== undefined || expect.json_array_length !== undefined
  if (!captureComplete && bodyChecks) {
    failed.push(`capture incomplete (body exceeded ${MAX_CAPTURE} bytes); no body assertion can pass against a prefix`)
    return failed
  }
  const bytes = Buffer.byteLength(body, "utf-8")
  if (expect.min_bytes !== undefined && bytes < expect.min_bytes) failed.push(`body ${bytes} bytes (expected at least ${expect.min_bytes})`)
  if (expect.contains !== undefined && !body.includes(expect.contains)) failed.push(`body does not contain ${JSON.stringify(expect.contains)}`)
  if (expect.json_nonempty_path !== undefined) {
    const v = jsonPath(body, expect.json_nonempty_path)
    const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
    if (empty) failed.push(`json path ${expect.json_nonempty_path} is empty or absent (a 200 with no rows is the silent failure this check exists for)`)
  }
  if (expect.json_array_length !== undefined) {
    const { path: p, exact, min, max } = expect.json_array_length
    const v = jsonPath(body, p)
    if (!Array.isArray(v)) failed.push(`json path ${p} is not an array`)
    else {
      if (exact !== undefined && v.length !== exact) failed.push(`json path ${p} has ${v.length} items (expected exactly ${exact})`)
      if (min !== undefined && v.length < min) failed.push(`json path ${p} has ${v.length} items (expected at least ${min})`)
      if (max !== undefined && v.length > max) failed.push(`json path ${p} has ${v.length} items (expected at most ${max}); exactly the requested limit is possibly truncated, never proof of completeness`)
    }
  }
  return failed
}

/** Read a body with a hard cap; abort and report incomplete rather than slice. */
async function captureBody(res: Response): Promise<{ body: string; complete: boolean }> {
  if (!res.body) return { body: await res.text(), complete: true }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CAPTURE) {
      await reader.cancel().catch(() => undefined)
      return { body: Buffer.concat(chunks).toString("utf-8"), complete: false }
    }
    chunks.push(value)
  }
  return { body: Buffer.concat(chunks).toString("utf-8"), complete: true }
}

export async function contractProbe(raw: ContractProbeInput, ledgerPath: string, specPath?: string, fetchImpl: typeof fetch = fetch, opts: ContractProbeOptions = {}): Promise<string> {
  const input = ContractProbeInputSchema.parse(raw)
  let method = input.method
  let urlText = input.url
  let headersIn = input.headers
  let expect = input.expect
  let timeoutMs = input.timeout_ms
  let claimId: string | undefined
  let contractSha: string | undefined
  if (input.claim_id !== undefined) {
    if (!specPath) return toKeyValue({ status: "error", error: "no_spec", hint: "claim mode needs the server's spec path" })
    const { contract, error } = await unitContract(specPath, input.unit_id)
    if (error) return toKeyValue({ status: "error", error: "contract_invalid", detail: error })
    if (!contract) return toKeyValue({ status: "error", error: "contract_missing", hint: `no \`\`\`foreman-contract block names unit '${input.unit_id}' in ${path.basename(specPath)}` })
    const claim = contract.contract.claims.find((c) => c.id === input.claim_id)
    if (!claim) return toKeyValue({ status: "error", error: "claim_unknown", hint: `unit '${input.unit_id}' registers claims: ${contract.contract.claims.map((c) => c.id).join(", ") || "none"}` })
    if (input.url !== undefined || Object.keys(input.headers).length || Object.keys(input.expect).length) {
      return toKeyValue({ status: "error", error: "claim_mode_takes_no_request", hint: "in claim mode the request and assertions come from the spec; drop url, headers and expect" })
    }
    method = claim.request.method
    urlText = claim.request.url
    headersIn = claim.request.headers
    expect = claim.assertions
    timeoutMs = claim.request.timeout_ms
    claimId = claim.id
    contractSha = contract.contract_sha256
  } else if (urlText === undefined) {
    return toKeyValue({ status: "error", error: "url_or_claim_required", hint: "pass claim_id (claim mode, satisfies preflight) or url (diagnostic mode, never satisfies a claim)" })
  }
  const url = new URL(urlText)
  const target = `${url.origin}${url.pathname}`   // the query may carry ids or tokens; the record keeps origin + path only
  const envNames = [...new Set(Object.values(headersIn).flatMap(envNamesIn))]
  const creds = await resolveNamedCredentials(envNames, { credentialsPath: opts.credentialsPath })
  if (!creds.ok) return toKeyValue({ status: "error", error: "credential_store_invalid", detail: creds.message })
  if (creds.missing.length) {
    return toKeyValue({ status: "error", error: "credential_missing", env: creds.missing.join(","), hint: `set ${creds.missing.join(", ")} in the server environment or in ~/.foreman-mcp/.env (process env wins); the value is never printed or stored` })
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(headersIn)) headers[k] = v.replace(ENV_TOKEN, (_m, name: string) => creds.values[name])
  const credentialSources = envNames.map((n) => `${n} (${creds.sources[n]})`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let body = ""
  let complete = true
  let transport: string | null = null
  try {
    const res = await fetchImpl(url, { method, headers, signal: controller.signal, redirect: "manual" })
    status = res.status
    if (method === "GET") ({ body, complete } = await captureBody(res))
  } catch (err) {
    transport = err instanceof Error ? (err.name === "AbortError" ? `timed out after ${timeoutMs} ms` : err.message) : String(err)
  } finally {
    clearTimeout(timer)
  }
  const failed = transport !== null ? [`transport: ${transport}`] : evaluate(expect, status, body, complete)
  const record: ProbeRecord = {
    ts: new Date().toISOString(),
    method,
    target,
    status: transport !== null ? null : status,
    bytes: Buffer.byteLength(body, "utf-8"),
    sha256: createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16),
    capture_complete: complete,
    asserted: Object.entries(expect).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
    passed: failed.length === 0,
    ...(failed.length ? { failed } : {}),
    ...(envNames.length ? { credentials: envNames } : {}),
    ...(claimId !== undefined ? { claim_id: claimId, contract_sha256: contractSha } : { diagnostic: true }),
  }
  let ledgerNote = ""
  try {
    await recordProbe(ledgerPath, input.phase, input.unit_id, record)
  } catch (err) {
    ledgerNote = err instanceof Error ? err.message : String(err)
  }
  return toKeyValue({
    status: record.passed ? "pass" : "fail",
    mode: claimId !== undefined ? `claim ${claimId}` : "diagnostic (never satisfies a claim)",
    phase: input.phase,
    unit_id: input.unit_id,
    method,
    target,
    http_status: record.status ?? "n/a",
    bytes: record.bytes,
    capture_complete: complete,
    body_sha256: record.sha256,
    asserted: record.asserted.join(",") || "2xx",
    failed: failed.join("; ") || "none",
    credentials_from_env: credentialSources.join(", ") || "none",
    recorded: ledgerNote ? `no (${ledgerNote})` : "yes (unit.probes)",
    note: "Executed by Foreman's HTTP client, GET/HEAD only. Proves this target answered this request now; it does not prove the application's own transport path (that is live_smoke). A failed or diagnostic probe never satisfies a claim.",
  })
}
