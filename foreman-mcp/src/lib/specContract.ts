/**
 * Spec contract (0.6.22, architecture council 2026-09-10). The spec is the authoring place
 * for a unit's external claims and its live smoke plan; the ledger is the execution
 * authority that freezes them. Nothing a tool call supplies can define a claim, a request,
 * an assertion or a smoke command: `contract_probe` takes a claim id and `live_smoke` a
 * plan id, and both load the definition from here.
 *
 * Authoring form, under the unit's heading in Docs/spec.md:
 *
 *   ```foreman-contract
 *   { "unit": "p11.2",
 *     "claims": [{ "id": "C-origin-zone", "text": "…", "request": { "method": "GET", "url": "https://…", "headers": { "authorization": "Bearer ${ENV:CF_TOKEN}" } },
 *                  "assertions": { "status": 200, "json_nonempty_path": "result", "json_array_length": { "path": "result", "max": 49 } } }],
 *     "smoke": { "id": "fetch-through-client", "runner": "go", "args": ["test", "-count=1", "-run", "^TestLive$", "./internal/cfsource"],
 *                "harness_files": ["internal/cfsource/live_test.go"], "input_files": ["internal/cfsource"], "env": ["CF_TOKEN"],
 *                "checks": { "stdout_contains": "ok" } } }
 *   ```
 *
 * `smoke: null` is a reviewed statement that the unit touches no external contract. In a
 * has_api phase a unit with no block at all is refused: omission is not an opt-out.
 *
 * Digests: the contract digest binds the definitions; the harness digest binds the files
 * the smoke plan lists; the input digest binds the application inputs it names. All three
 * are server-computed over paths and contents, so a receipt goes stale when any of them
 * changes, and no clock is involved.
 */
import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { z } from "zod"

export const CONTRACT_FENCE = "foreman-contract"
export const MAX_CLAIMS = 16
export const MAX_DIGEST_FILES = 2000
const MAX_DIGEST_FILE_BYTES = 4 * 1024 * 1024
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", ".next", "coverage", "obj"])

export const ClaimAssertionsSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  min_bytes: z.number().int().min(0).optional(),
  contains: z.string().min(1).max(400).optional(),
  json_nonempty_path: z.string().max(400).optional(),
  /** Version-one relational check: the array at `path` must have a length within the bounds. */
  json_array_length: z.object({
    path: z.string().min(1).max(400),
    exact: z.number().int().min(0).optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  }).optional(),
})
export type ClaimAssertions = z.infer<typeof ClaimAssertionsSchema>

export const ClaimSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/),
  text: z.string().trim().min(8).max(1000),
  request: z.object({
    method: z.enum(["GET", "HEAD"]).default("GET"),
    url: z.string().url().max(4096),
    headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  }),
  assertions: ClaimAssertionsSchema.default({}),
})
export type Claim = z.infer<typeof ClaimSchema>

export const SmokePlanSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/),
  runner: z.string().min(1).max(260),
  args: z.array(z.string().max(2000)).max(50).default([]),
  cwd: z.string().max(4096).default("."),
  /** Environment variable NAMES the smoke needs set; values are never read into the ledger. */
  env: z.array(z.string().regex(/^[A-Z0-9_]+$/)).max(20).default([]),
  /** Files whose contents decide the verdict: the harness, its helpers, fixtures and wiring. Digested. */
  harness_files: z.array(z.string().min(1).max(4096)).min(1).max(50),
  /** Application inputs the smoke exercises (files or directories). Digested at smoke time and at verdict. */
  input_files: z.array(z.string().min(1).max(4096)).min(1).max(50),
  timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  checks: z.object({
    exit_code: z.number().int().default(0),
    stdout_contains: z.string().min(1).max(400).optional(),
    stdout_not_contains: z.string().min(1).max(400).optional(),
  }).default({ exit_code: 0 }),
})
export type SmokePlan = z.infer<typeof SmokePlanSchema>

export const UnitContractSchema = z.object({
  unit: z.string().min(1).max(200),
  claims: z.array(ClaimSchema).max(MAX_CLAIMS).default([]),
  /** A plan, or an explicit reviewed null. */
  smoke: SmokePlanSchema.nullable(),
})
export type UnitContract = z.infer<typeof UnitContractSchema>

export interface ParsedContract {
  unit: string
  contract: UnitContract
  /** sha256 hex[0:16] of the canonical JSON: the digest every receipt binds. */
  contract_sha256: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function contractDigest(contract: UnitContract): string {
  return createHash("sha256").update(canonical(contract), "utf-8").digest("hex").slice(0, 16)
}

export interface ContractParseResult {
  contracts: Map<string, ParsedContract>
  /** Fatal problems: a malformed block fails closed for its unit. */
  errors: string[]
}

/** Every ```foreman-contract block in the spec. Duplicate units and duplicate ids fail closed. */
export function parseContracts(spec: string): ContractParseResult {
  const contracts = new Map<string, ParsedContract>()
  const errors: string[] = []
  const re = new RegExp("```" + CONTRACT_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```", "g")
  let n = 0
  for (const m of spec.matchAll(re)) {
    n += 1
    let raw: unknown
    try {
      raw = JSON.parse(m[1])
    } catch (err) {
      errors.push(`block ${n}: not JSON (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    const parsed = UnitContractSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(`block ${n}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`)
      continue
    }
    const c = parsed.data
    const ids = c.claims.map((x) => x.id)
    if (new Set(ids).size !== ids.length) {
      errors.push(`block ${n} (unit ${c.unit}): duplicate claim ids`)
      continue
    }
    if (contracts.has(c.unit)) {
      errors.push(`block ${n}: unit ${c.unit} has more than one contract block`)
      contracts.delete(c.unit)
      continue
    }
    contracts.set(c.unit, { unit: c.unit, contract: c, contract_sha256: contractDigest(c) })
  }
  return { contracts, errors }
}

export async function readContracts(specPath: string): Promise<ContractParseResult> {
  let spec: string
  try {
    spec = await fs.readFile(specPath, "utf-8")
  } catch {
    return { contracts: new Map(), errors: [] }
  }
  return parseContracts(spec)
}

/** The contract for one unit, or why there is none. */
export async function unitContract(specPath: string, unitId: string): Promise<{ contract: ParsedContract | null; error: string | null }> {
  const { contracts, errors } = await readContracts(specPath)
  const own = errors.filter((e) => e.includes(`unit ${unitId}`) || e.includes(`(unit ${unitId})`))
  if (own.length) return { contract: null, error: own.join("; ") }
  return { contract: contracts.get(unitId) ?? null, error: null }
}

async function* walk(root: string, rel: string, state: { count: number }): AsyncGenerator<string> {
  let entries: import("fs").Dirent[]
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.count >= MAX_DIGEST_FILES) return
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      yield* walk(root, r, state)
    } else if (e.isFile()) {
      state.count += 1
      yield r
    }
  }
}

export interface PathDigest {
  sha256: string
  files: number
  /** Paths that resolved to nothing; a missing harness file is a broken plan, not an empty one. */
  missing: string[]
  truncated: boolean
}

/**
 * Digest over a list of files or directories: sorted paths and contents. Bounded. Paths
 * that escape the root are refused as missing. Server-computed, never caller-supplied.
 */
export async function digestPaths(root: string, paths: string[]): Promise<PathDigest> {
  const hash = createHash("sha256")
  const missing: string[] = []
  const state = { count: 0 }
  const seen = new Set<string>()
  const add = async (rel: string) => {
    const norm = rel.replace(/\\/g, "/")
    if (seen.has(norm)) return
    seen.add(norm)
    const abs = path.join(root, norm)
    try {
      const st = await fs.stat(abs)
      if (st.size > MAX_DIGEST_FILE_BYTES) {
        hash.update(`${norm}\0big:${st.size}\0`)
        return
      }
      hash.update(`${norm}\0`).update(await fs.readFile(abs)).update("\0")
    } catch {
      missing.push(norm)
    }
  }
  for (const p of [...paths].map((x) => x.replace(/\\/g, "/").replace(/^\.\//, "")).sort()) {
    const abs = path.resolve(root, p)
    if (path.relative(root, abs).startsWith("..")) {
      missing.push(p)
      continue
    }
    let st: import("fs").Stats
    try {
      st = await fs.stat(abs)
    } catch {
      missing.push(p)
      continue
    }
    if (st.isDirectory()) {
      for await (const rel of walk(abs, "", state)) await add(`${p}/${rel}`)
    } else {
      state.count += 1
      await add(p)
    }
  }
  return { sha256: hash.digest("hex").slice(0, 16), files: seen.size, missing, truncated: state.count >= MAX_DIGEST_FILES }
}
