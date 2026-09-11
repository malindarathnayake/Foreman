/**
 * verify_oracle (0.6.20). Field report 2026-09-10: the protocol asks for a targeted
 * mutation probe ("replacing or removing the control must make the focused suite fail")
 * and shipped no tool, so the pit-boss hand-rolled one per project. This is that tool as
 * a first-class, recorded artifact.
 *
 * For each mutation: the file must contain `old` exactly once; the tool writes `new`,
 * runs the guard test, restores the original bytes and verifies the restore by hash. A
 * mutation is KILLED when the guard test fails while it is applied, SURVIVED when the
 * suite stays green (the suite cannot observe that control), and INVALID when `old` is
 * absent or ambiguous. Any restore failure aborts loudly: the file is named and the run
 * stops, because a tree left mutated is worse than a missing probe.
 *
 * The runner goes through run_tests' allowlist and output shaping; the report is what the
 * ledger records on the unit (recordOracle), and the repeated-block rule reads it.
 */
import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { z } from "zod"
import { runTests } from "./runTests.js"
import { toKeyValue, toTable } from "../lib/toon.js"

export const VerifyOracleInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  mutations: z.array(z.object({
    label: z.string().min(1).max(200),
    file: z.string().min(1).max(4096),
    old: z.string().min(1).max(20000),
    new: z.string().max(20000),
    /** The focused guard test for this control: runner + args exactly as run_tests takes them. */
    runner: z.string().min(1).max(260),
    args: z.array(z.string().max(2000)).max(50).default([]),
  })).min(1).max(12),
  repo_root: z.string().max(4096).optional(),
  timeout_ms: z.number().int().min(1000).max(600000).default(120000),
})
export type VerifyOracleInput = z.infer<typeof VerifyOracleInputSchema>

export type MutationOutcome = "killed" | "survived" | "invalid"
export interface MutationResult {
  label: string
  file: string
  outcome: MutationOutcome
  exit_code: number | null
  detail: string
}
export interface OracleReport {
  phase: string
  unit_id: string
  ts: string
  mutations: number
  killed: number
  survivors: string[]
  invalid: string[]
  results: MutationResult[]
}

type Runner = (runner: string, args: string[], timeoutMs: number, cwd: string) => Promise<string>

function sha(text: Buffer): string {
  return createHash("sha256").update(text).digest("hex")
}

function exitCodeOf(output: string): number | null {
  const m = /^exit_code:\s*(-?\d+)/m.exec(output)
  return m ? Number(m[1]) : null
}

/** Why a run cannot be read as a behavioural verdict: refused, never started, timed out, or aborted. */
function inconclusive(output: string): string | null {
  if (output.startsWith("error:")) return output.split("\n")[0].slice(0, 200)
  if (/^timed_out:\s*true/m.test(output)) return "guard timed out; a timeout is not a kill"
  const code = exitCodeOf(output)
  if (code === null || code === -1) return "guard did not start or was aborted (exit -1); not a kill"
  return null
}

/** A guard argument that names the mutated file's directory, or a Make-style target that cannot be checked. */
function relevanceHint(file: string, args: string[]): string {
  const dir = path.posix.dirname(file.replace(/\\/g, "/"))
  if (dir === ".") return ""
  const pathArgs = args.filter((a) => /[\\/]/.test(a))
  if (pathArgs.length === 0) return ""
  return pathArgs.some((a) => a.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\.\.\.$/, "").startsWith(dir) || dir.startsWith(a.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\.\.\.$/, "")))
    ? ""
    : " (hint: no guard argument names this file's directory; the guard may not exercise it)"
}

/**
 * Run every mutation, restoring the tree after each. Throws only on a failed or unsafe
 * restore. Per Codex review (2026-09-10): each distinct guard configuration is run once
 * UNMUTATED first and must be green, or every mutation under it is invalid; a timed-out,
 * refused or aborted mutated run is invalid, never a kill; and the restore refuses to
 * overwrite bytes that are neither the mutation nor the original, so a concurrent write
 * during the probe is never silently erased.
 */
export async function runOracle(input: VerifyOracleInput, runner: Runner = (r, a, t, c) => runTests(r, a, t, undefined, undefined, c)): Promise<OracleReport> {
  const root = path.resolve(input.repo_root ?? process.cwd())
  const results: MutationResult[] = []
  const baselines = new Map<string, string | null>()   // config key -> null when green, else the reason it is red
  const baselineFor = async (m: VerifyOracleInput["mutations"][number]): Promise<string | null> => {
    const key = JSON.stringify([m.runner, m.args])
    if (!baselines.has(key)) {
      const out = await runner(m.runner, m.args, input.timeout_ms, root)
      const bad = inconclusive(out)
      const code = exitCodeOf(out)
      baselines.set(key, bad !== null ? `baseline red: ${bad}` : code !== 0 ? `baseline red: guard exits ${code} unmutated; fix the guard before probing` : null)
    }
    return baselines.get(key)!
  }
  for (const m of input.mutations) {
    const abs = path.resolve(root, m.file)
    if (path.relative(root, abs).startsWith("..")) {
      results.push({ label: m.label, file: m.file, outcome: "invalid", exit_code: null, detail: "file is outside the repository root" })
      continue
    }
    let original: Buffer
    try {
      original = await fs.readFile(abs)
    } catch {
      results.push({ label: m.label, file: m.file, outcome: "invalid", exit_code: null, detail: "file not found" })
      continue
    }
    const text = original.toString("utf-8")
    const count = text.split(m.old).length - 1
    if (count !== 1) {
      results.push({ label: m.label, file: m.file, outcome: "invalid", exit_code: null, detail: `old text occurs ${count} times; it must occur exactly once` })
      continue
    }
    const red = await baselineFor(m)
    if (red !== null) {
      results.push({ label: m.label, file: m.file, outcome: "invalid", exit_code: null, detail: red })
      continue
    }
    const originalHash = sha(original)
    const mutated = Buffer.from(text.replace(m.old, m.new), "utf-8")
    const mutatedHash = sha(mutated)
    let output = ""
    try {
      await fs.writeFile(abs, mutated)
      output = await runner(m.runner, m.args, input.timeout_ms, root)
    } finally {
      let restoredHash: string | null = null
      let cause = ""
      try {
        const current = sha(await fs.readFile(abs))
        if (current === mutatedHash) {
          await fs.writeFile(abs, original)
        } else if (current !== originalHash) {
          throw new Error("the file changed during the probe and holds neither the mutation nor the original; it was left untouched")
        }
        restoredHash = sha(await fs.readFile(abs))
      } catch (err) {
        cause = err instanceof Error ? err.message : String(err)
      }
      if (restoredHash !== originalHash) {
        throw new Error(
          `ORACLE RESTORE FAILED: ${m.file} does not match its original bytes after mutation '${m.label}'` +
          `${cause ? ` (${cause})` : ""}; inspect it before doing anything else.`
        )
      }
    }
    const code = exitCodeOf(output)
    const bad = inconclusive(output)
    const hint = relevanceHint(m.file, m.args)
    if (bad !== null) {
      results.push({ label: m.label, file: m.file, outcome: "invalid", exit_code: code, detail: bad + hint })
    } else if (code === 0) {
      results.push({ label: m.label, file: m.file, outcome: "survived", exit_code: code, detail: "guard test stayed green with the control removed" + hint })
    } else {
      results.push({ label: m.label, file: m.file, outcome: "killed", exit_code: code, detail: "guard test failed with the control removed" + hint })
    }
  }
  return {
    phase: input.phase, unit_id: input.unit_id, ts: new Date().toISOString(),
    mutations: input.mutations.length,
    killed: results.filter((r) => r.outcome === "killed").length,
    survivors: results.filter((r) => r.outcome === "survived").map((r) => r.label),
    invalid: results.filter((r) => r.outcome === "invalid").map((r) => r.label),
    results,
  }
}

export function renderOracle(report: OracleReport): string {
  const head = toKeyValue({
    phase: report.phase,
    unit_id: report.unit_id,
    mutations: report.mutations,
    killed: report.killed,
    survivors: report.survivors.join(",") || "none",
    invalid: report.invalid.join(",") || "none",
    verdict: report.invalid.length > 0 ? "incomplete" : report.survivors.length === 0 ? "oracle_holds" : "oracle_blind",
    note: report.survivors.length > 0
      ? "A survivor is a control the focused suite cannot observe: add or fix the guard test before another reading-only review."
      : "Every mutation was caught by its guard test. This is test evidence, not a review.",
  })
  return `${head}\n${toTable(["label", "file", "outcome", "exit", "detail"], report.results.map((r) => [r.label, r.file, r.outcome, r.exit_code === null ? "-" : String(r.exit_code), r.detail]))}`
}
