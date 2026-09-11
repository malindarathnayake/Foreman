/**
 * Spec contract (0.6.22, architecture council 2026-09-10; deliverables and strict parsing
 * 0.6.24, Codex deliberation 2026-09-10). The spec is the authoring place for a unit's
 * external claims, its live smoke plan and the deliverables that plan must produce; the
 * ledger is the execution authority that freezes them. Nothing a tool call supplies can
 * define a claim, a request, an assertion, a smoke command or a deliverable: `contract_probe`
 * takes a claim id and `live_smoke` a plan id, and both load the definition from here.
 *
 * Authoring form, under the unit's heading in Docs/spec.md:
 *
 *   ```foreman-contract
 *   { "unit": "p11.2",
 *     "claims": [{ "id": "C-origin-zone", "text": "…", "request": { "method": "GET", "url": "https://…", "headers": { "authorization": "Bearer ${ENV:CF_TOKEN}" } },
 *                  "assertions": { "status": 200, "json_nonempty_path": "result", "json_array_length": { "path": "result", "max": 49 } } }],
 *     "smoke": { "id": "fetch-through-client", "runner": "go", "args": ["run", "./cmd/emit", "--out", "out/map.json"],
 *                "harness_files": ["cmd/emit/main.go"], "input_files": ["internal/cfsource"], "env": ["CF_TOKEN"],
 *                "checks": { "stdout_contains": "ok" } },
 *     "deliverables": [{ "id": "map", "path": "out/map.json",
 *                        "assertions": { "max_bytes": 65536, "json_array_length": { "path": "rows", "min": 1 },
 *                                        "values_in": { "path": "rows[].country", "reference": "Docs/iso-3166-alpha2.txt" } } }] }
 *   ```
 *
 * `smoke: null` is a reviewed statement that the unit touches no external contract; an empty
 * `deliverables` list is a reviewed statement that the unit emits nothing Foreman should
 * observe. In a has_api phase a unit with no block at all is refused: omission is not an
 * opt-out. Unknown fields REFUSE the block (0.6.24): a field this server does not know is a
 * field it would not enforce, and a silently stripped one would still digest the same.
 *
 * Digests: the contract digest binds the definitions; the harness digest binds the files the
 * smoke plan lists; the input digest binds the application inputs it names; a deliverable
 * digest binds the bytes the plan produced; a reference digest binds the value set a
 * `values_in` assertion reads. All are server-computed over COMPLETE file contents (0.6.24:
 * the earlier helper hashed path and size only past 4 MiB, so a same-size content swap kept
 * its digest), so a receipt goes stale when any of them changes, and no clock is involved.
 */
import fs from "fs/promises"
import { createReadStream } from "fs"
import path from "path"
import { createHash } from "crypto"
import { z } from "zod"

export const CONTRACT_FENCE = "foreman-contract"
export const MAX_CLAIMS = 16
export const MAX_DELIVERABLES = 20
export const MAX_DIGEST_FILES = 2000
/** Total bytes one digest call will read before it reports an incomplete inventory. */
export const MAX_DIGEST_TOTAL_BYTES = 512 * 1024 * 1024
/** Largest single deliverable Foreman will read into memory to evaluate. */
export const MAX_DELIVERABLE_BYTES = 64 * 1024 * 1024
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", ".next", "coverage", "obj"])

const ArrayLengthSchema = z.strictObject({
  path: z.string().min(1).max(400),
  exact: z.number().int().min(0).optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
})

/** A length assertion observes nothing without a bound; exact with min/max is contradictory. */
function arrayLengthProblem(a: z.infer<typeof ArrayLengthSchema>): string | null {
  if (a.exact === undefined && a.min === undefined && a.max === undefined) return `json_array_length on ${a.path} has no bound (exact, min or max)`
  if (a.exact !== undefined && (a.min !== undefined || a.max !== undefined)) return `json_array_length on ${a.path} mixes exact with min/max`
  if (a.min !== undefined && a.max !== undefined && a.min > a.max) return `json_array_length on ${a.path} has min ${a.min} above max ${a.max}`
  return null
}

export const ClaimAssertionsSchema = z.strictObject({
  status: z.number().int().min(100).max(599).optional(),
  min_bytes: z.number().int().min(0).optional(),
  contains: z.string().min(1).max(400).optional(),
  json_nonempty_path: z.string().max(400).optional(),
  /** Version-one relational check: the array at `path` must have a length within the bounds. */
  json_array_length: ArrayLengthSchema.optional(),
})
export type ClaimAssertions = z.infer<typeof ClaimAssertionsSchema>

export const ClaimSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/),
  text: z.string().trim().min(8).max(1000),
  request: z.strictObject({
    method: z.enum(["GET", "HEAD"]).default("GET"),
    url: z.string().url().max(4096),
    headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  }),
  assertions: ClaimAssertionsSchema.default({}),
})
export type Claim = z.infer<typeof ClaimSchema>

export const SmokePlanSchema = z.strictObject({
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
  checks: z.strictObject({
    exit_code: z.number().int().default(0),
    stdout_contains: z.string().min(1).max(400).optional(),
    stdout_not_contains: z.string().min(1).max(400).optional(),
  }).default({ exit_code: 0 }),
})
export type SmokePlan = z.infer<typeof SmokePlanSchema>

/**
 * 0.6.24: what Foreman observes on the bytes a deliverable holds after the smoke plan ran.
 * A closed set: size bounds, the two JSON checks the probe already has, and file-backed
 * membership. No expressions, no transformations, no claim-backed sets (a hash of a set
 * cannot answer whether "ZZ" is in it after a reload).
 */
export const DeliverableAssertionsSchema = z.strictObject({
  min_bytes: z.number().int().min(0).optional(),
  max_bytes: z.number().int().min(1).optional(),
  json_nonempty_path: z.string().min(1).max(400).optional(),
  json_array_length: ArrayLengthSchema.optional(),
  /**
   * Every value selected by `path` must appear in `reference`, a repo-relative text file with
   * one allowed value per line (`#` comments and blank lines ignored). `path` is a dot path
   * whose segments may end in `[]` to project across an array of records: `rows[].country`.
   * A missing field on any record, a non-string leaf, an empty selection or an unreadable
   * reference fails. The reference digest is frozen on the delegation, so the worker cannot
   * rewrite the oracle it is measured against.
   */
  values_in: z.strictObject({
    path: z.string().min(1).max(400),
    reference: z.string().min(1).max(4096),
  }).optional(),
})
export type DeliverableAssertions = z.infer<typeof DeliverableAssertionsSchema>

export const DeliverableSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/),
  /** One repo-relative FILE the smoke plan produces. No globs, no directories. */
  path: z.string().min(1).max(4096).refine((p) => !/[*?[\]{}]/.test(p), "deliverable path is one file, not a glob"),
  assertions: DeliverableAssertionsSchema,
})
export type Deliverable = z.infer<typeof DeliverableSchema>

export const UnitContractSchema = z.strictObject({
  unit: z.string().min(1).max(200),
  claims: z.array(ClaimSchema).max(MAX_CLAIMS).default([]),
  /** A plan, or an explicit reviewed null. */
  smoke: SmokePlanSchema.nullable(),
  /** Files the plan must produce and what Foreman checks on their bytes. Empty = reviewed: nothing to observe. */
  deliverables: z.array(DeliverableSchema).max(MAX_DELIVERABLES).default([]),
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

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
const under = (file: string, dir: string) => file === dir || file.startsWith(dir + "/")

/** Semantic problems the schema cannot state: a deliverable with nothing to observe, a producer-less deliverable, colliding paths. */
export function contractProblems(c: UnitContract): string[] {
  const out: string[] = []
  for (const claim of c.claims) {
    const p = claim.assertions.json_array_length && arrayLengthProblem(claim.assertions.json_array_length)
    if (p) out.push(`claim ${claim.id}: ${p}`)
  }
  if (c.deliverables.length && !c.smoke) out.push("deliverables need a producer: declare the smoke plan that emits them (smoke: null cannot produce a deliverable)")
  const ids = new Set<string>()
  const paths = new Set<string>()
  const harness = new Set((c.smoke?.harness_files ?? []).map(norm))
  const inputs = (c.smoke?.input_files ?? []).map(norm)
  for (const d of c.deliverables) {
    if (ids.has(d.id)) out.push(`deliverable ids repeat: ${d.id}`)
    ids.add(d.id)
    const p = norm(d.path)
    if (paths.has(p)) out.push(`deliverable paths repeat: ${p}`)
    paths.add(p)
    if (harness.has(p)) out.push(`deliverable ${d.id}: ${p} is also a harness file; a plan cannot produce its own harness`)
    const inside = inputs.find((i) => under(p, i))
    if (inside) out.push(`deliverable ${d.id}: ${p} is inside input_files entry ${inside}; producing it would change the input digest and invalidate the run`)
    const a = d.assertions
    const lengthProblem = a.json_array_length && arrayLengthProblem(a.json_array_length)
    if (lengthProblem) out.push(`deliverable ${d.id}: ${lengthProblem}`)
    if (a.min_bytes !== undefined && a.max_bytes !== undefined && a.min_bytes > a.max_bytes) out.push(`deliverable ${d.id}: min_bytes above max_bytes`)
    const meaningful = (a.min_bytes ?? 0) > 0 || a.max_bytes !== undefined || a.json_nonempty_path !== undefined ||
      (a.json_array_length !== undefined && !lengthProblem) || a.values_in !== undefined
    if (!meaningful) out.push(`deliverable ${d.id}: declares no observable property (min_bytes > 0, max_bytes, json_nonempty_path, a bounded json_array_length or values_in)`)
    if (a.values_in) {
      const ref = norm(a.values_in.reference)
      if (paths.has(ref) || c.deliverables.some((o) => norm(o.path) === ref)) out.push(`deliverable ${d.id}: its values_in reference ${ref} is itself a deliverable; a run cannot write its own allowed set`)
      if (harness.has(ref)) out.push(`deliverable ${d.id}: its values_in reference ${ref} is a harness file`)
    }
  }
  return out
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
      const unitName = raw && typeof raw === "object" && typeof (raw as { unit?: unknown }).unit === "string" ? ` (unit ${(raw as { unit: string }).unit})` : ""
      errors.push(`block ${n}${unitName}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`)
      continue
    }
    const c = parsed.data
    const ids = c.claims.map((x) => x.id)
    if (new Set(ids).size !== ids.length) {
      errors.push(`block ${n} (unit ${c.unit}): duplicate claim ids`)
      continue
    }
    const problems = contractProblems(c)
    if (problems.length) {
      errors.push(`block ${n} (unit ${c.unit}): ${problems.join("; ")}`)
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

// ─── Digests ─────────────────────────────────────────────────────────────────

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
    } else if (e.isFile() || e.isSymbolicLink()) {
      state.count += 1
      yield r
    }
  }
}

/** The canonical path of `abs` when it stays inside the canonical root, else null (a link out of the tree is not observed). */
async function contained(root: string, abs: string): Promise<string | null> {
  let realRoot: string
  let real: string
  try {
    realRoot = await fs.realpath(root)
    real = await fs.realpath(abs)
  } catch {
    return null
  }
  const rel = path.relative(realRoot, real)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null
  return real
}

/** Feed a file's complete bytes into a hash; returns the byte count. */
async function hashFile(hash: ReturnType<typeof createHash>, abs: string): Promise<number> {
  let bytes = 0
  for await (const chunk of createReadStream(abs)) {
    const buf = chunk as Buffer
    hash.update(buf)
    bytes += buf.length
  }
  return bytes
}

export interface PathDigest {
  sha256: string
  files: number
  /** Paths that resolved to nothing, escaped the root, or could not be read; a missing harness file is a broken plan, not an empty one. */
  missing: string[]
  /** True when the inventory hit MAX_DIGEST_FILES or MAX_DIGEST_TOTAL_BYTES; a truncated digest observes nothing and callers refuse it. */
  truncated: boolean
}

/**
 * Digest over a list of files or directories: sorted paths and COMPLETE contents. Bounded by
 * file count and total bytes; past either bound the result is marked truncated. Symlinks are
 * followed only while their target stays inside the root. Server-computed, never caller-supplied.
 */
export async function digestPaths(root: string, paths: string[]): Promise<PathDigest> {
  const hash = createHash("sha256")
  const missing: string[] = []
  const state = { count: 0 }
  const seen = new Set<string>()
  let total = 0
  let truncated = false
  const add = async (rel: string) => {
    const n = norm(rel)
    if (seen.has(n)) return
    seen.add(n)
    const real = await contained(root, path.join(root, n))
    if (real === null) {
      missing.push(n)
      return
    }
    let st: import("fs").Stats
    try {
      st = await fs.stat(real)
    } catch {
      missing.push(n)
      return
    }
    if (!st.isFile()) {
      missing.push(n)
      return
    }
    if (total + st.size > MAX_DIGEST_TOTAL_BYTES) {
      truncated = true
      return
    }
    hash.update(`${n}\0`)
    total += await hashFile(hash, real)
    hash.update("\0")
  }
  for (const p of [...paths].map(norm).sort()) {
    const abs = path.resolve(root, p)
    if (path.relative(root, abs).startsWith("..") || path.isAbsolute(path.relative(root, abs))) {
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
      if (state.count >= MAX_DIGEST_FILES) truncated = true
    } else {
      state.count += 1
      await add(p)
    }
  }
  return { sha256: hash.digest("hex").slice(0, 16), files: seen.size, missing, truncated }
}

export interface FileDigest {
  exists: boolean
  sha256: string | null
  bytes: number
  /** Why the file could not be observed although it exists (too large, escapes the root, not a regular file). */
  problem: string | null
}

/** Digest of one file's complete bytes, or a stated reason it was not observed. No directory exclusions apply: a deliverable is named exactly. */
export async function digestFile(root: string, rel: string): Promise<FileDigest> {
  const n = norm(rel)
  const abs = path.resolve(root, n)
  if (path.relative(root, abs).startsWith("..") || path.isAbsolute(path.relative(root, abs))) return { exists: false, sha256: null, bytes: 0, problem: "path escapes the repository root" }
  let st: import("fs").Stats
  try {
    st = await fs.lstat(abs)
  } catch {
    return { exists: false, sha256: null, bytes: 0, problem: null }
  }
  const real = await contained(root, abs)
  if (real === null) return { exists: true, sha256: null, bytes: 0, problem: "resolves outside the repository root" }
  try {
    st = await fs.stat(real)
  } catch {
    return { exists: false, sha256: null, bytes: 0, problem: null }
  }
  if (!st.isFile()) return { exists: true, sha256: null, bytes: st.size, problem: "not a regular file" }
  if (st.size > MAX_DELIVERABLE_BYTES) return { exists: true, sha256: null, bytes: st.size, problem: `larger than ${MAX_DELIVERABLE_BYTES} bytes; too large to observe` }
  const hash = createHash("sha256")
  const bytes = await hashFile(hash, real)
  return { exists: true, sha256: hash.digest("hex").slice(0, 16), bytes, problem: null }
}

// ─── Evaluation over bytes ───────────────────────────────────────────────────

/** Dot-path lookup with numeric indices; no projection. Shared with contract_probe. */
export function jsonPath(body: string, dotPath: string): unknown {
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

/**
 * Selects the values a `values_in.path` names: segments ending in `[]` project across an
 * array of records, the last segment may itself be an array of scalars. Every leaf must be a
 * string; a missing field on any record fails; an empty selection fails (nothing observed).
 */
export function selectValues(body: string, dotPath: string): { values: string[]; error: string | null } {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    return { values: [], error: "not JSON" }
  }
  const segments = dotPath.split(".").filter(Boolean)
  const leaves: unknown[] = []
  const visit = (node: unknown, i: number, where: string): string | null => {
    if (i === segments.length) {
      if (Array.isArray(node)) leaves.push(...node)
      else leaves.push(node)
      return null
    }
    const seg = segments[i]
    const project = seg.endsWith("[]")
    const key = project ? seg.slice(0, -2) : seg
    if (node === null || typeof node !== "object" || Array.isArray(node)) return `${where || "root"} is not an object`
    if (!(key in (node as object))) return `${where ? where + "." : ""}${key} is absent`
    const next = (node as Record<string, unknown>)[key]
    if (!project) return visit(next, i + 1, `${where ? where + "." : ""}${key}`)
    if (!Array.isArray(next)) return `${where ? where + "." : ""}${key} is not an array`
    for (let k = 0; k < next.length; k++) {
      const err = visit(next[k], i + 1, `${where ? where + "." : ""}${key}[${k}]`)
      if (err) return err
    }
    return null
  }
  const err = visit(root, 0, "")
  if (err) return { values: [], error: err }
  if (leaves.length === 0) return { values: [], error: "empty selection; nothing observed" }
  const bad = leaves.findIndex((v) => typeof v !== "string")
  if (bad >= 0) return { values: [], error: `value ${bad} is ${leaves[bad] === null ? "null" : typeof leaves[bad]}, not a string` }
  return { values: leaves as string[], error: null }
}

/** One allowed value per line; `#` comments and blank lines ignored. */
export function parseReference(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const v = line.replace(/#.*$/, "").trim()
    if (v) out.add(v)
  }
  return out
}

/** Every failed deliverable assertion, in prose. `references` maps reference paths to their parsed value sets (null = unreadable). */
export function evaluateDeliverable(bytes: Buffer, a: DeliverableAssertions, references: Map<string, Set<string> | null>): string[] {
  const failed: string[] = []
  if (a.min_bytes !== undefined && bytes.length < a.min_bytes) failed.push(`${bytes.length} bytes (expected at least ${a.min_bytes})`)
  if (a.max_bytes !== undefined && bytes.length > a.max_bytes) failed.push(`${bytes.length} bytes (expected at most ${a.max_bytes})`)
  const body = bytes.toString("utf-8")
  if (a.json_nonempty_path !== undefined) {
    const v = jsonPath(body, a.json_nonempty_path)
    const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
    if (empty) failed.push(`json path ${a.json_nonempty_path} is empty or absent`)
  }
  if (a.json_array_length !== undefined) {
    const { path: p, exact, min, max } = a.json_array_length
    const v = jsonPath(body, p)
    if (!Array.isArray(v)) failed.push(`json path ${p} is not an array`)
    else {
      if (exact !== undefined && v.length !== exact) failed.push(`json path ${p} has ${v.length} items (expected exactly ${exact})`)
      if (min !== undefined && v.length < min) failed.push(`json path ${p} has ${v.length} items (expected at least ${min})`)
      if (max !== undefined && v.length > max) failed.push(`json path ${p} has ${v.length} items (expected at most ${max})`)
    }
  }
  if (a.values_in !== undefined) {
    const allowed = references.get(norm(a.values_in.reference))
    if (allowed === undefined || allowed === null) failed.push(`values_in: reference ${a.values_in.reference} is unreadable`)
    else if (allowed.size === 0) failed.push(`values_in: reference ${a.values_in.reference} lists no values`)
    else {
      const sel = selectValues(body, a.values_in.path)
      if (sel.error) failed.push(`values_in: ${a.values_in.path}: ${sel.error}`)
      else {
        const outside = [...new Set(sel.values.filter((v) => !allowed.has(v)))]
        if (outside.length) failed.push(`values_in: ${outside.length} value(s) at ${a.values_in.path} not in ${a.values_in.reference}: ${outside.slice(0, 8).join(", ")}${outside.length > 8 ? ", …" : ""}`)
      }
    }
  }
  return failed
}

/** Reference files a contract's deliverables read, normalized and deduplicated. */
export function referencePaths(c: UnitContract): string[] {
  return [...new Set(c.deliverables.flatMap((d) => (d.assertions.values_in ? [norm(d.assertions.values_in.reference)] : [])))].sort()
}

/** Digest every reference file; a missing one is reported by path. */
export async function digestReferences(root: string, c: UnitContract): Promise<{ digests: Record<string, string>; missing: string[] }> {
  const digests: Record<string, string> = {}
  const missing: string[] = []
  for (const ref of referencePaths(c)) {
    const d = await digestFile(root, ref)
    if (!d.exists || d.sha256 === null) missing.push(ref)
    else digests[ref] = d.sha256
  }
  return { digests, missing }
}

/** Read every reference file into its value set; unreadable ones map to null. */
export async function readReferences(root: string, c: UnitContract): Promise<Map<string, Set<string> | null>> {
  const out = new Map<string, Set<string> | null>()
  for (const ref of referencePaths(c)) {
    try {
      const real = await contained(root, path.resolve(root, ref))
      out.set(ref, real === null ? null : parseReference(await fs.readFile(real, "utf-8")))
    } catch {
      out.set(ref, null)
    }
  }
  return out
}
