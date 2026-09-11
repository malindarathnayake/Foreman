/**
 * live_smoke (0.6.22, architecture council 2026-09-10). Runs the UNIT'S OWN code path
 * against the real system through the project's real runner, and records a receipt the
 * verdict gate reads. This is what turned "94.6% coverage, six killed mutations, green
 * suite, clean guard" into "cannot complete a single HTTPS request": Foreman's HTTP client
 * proves the endpoint; only the application's transport proves the application.
 *
 * The call carries a plan id and nothing else. The command, working directory, required
 * environment names, harness inventory, application inputs and checks come from the smoke
 * plan registered in the spec's foreman-contract block, so a caller cannot substitute
 * `echo pass` for the harness. The receipt binds the current attempt, the contract digest,
 * a digest of the harness files and a digest of the application inputs; set_verdict pass
 * in a has_api phase recomputes those digests and refuses when any moved. A run whose
 * inputs change while it executes is invalid. A newer failed run supersedes a pass.
 *
 * What this proves: Foreman executed the frozen recipe on these bytes at this time and saw
 * this result. What it does not prove: that the harness honestly exercises production
 * code. That is what harness review is for, and the harness inventory is what it reviews.
 */
import path from "path"
import { createHash } from "crypto"
import { z } from "zod"
import { runTests } from "./runTests.js"
import { recordSmoke, type SmokeReceipt } from "../lib/ledger.js"
import { digestPaths, unitContract } from "../lib/specContract.js"
import { readLedgerWithStatus } from "../lib/ledger.js"
import { toKeyValue } from "../lib/toon.js"

export const LiveSmokeInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  plan_id: z.string().min(1).max(64),
})
export type LiveSmokeInput = z.infer<typeof LiveSmokeInputSchema>

type Runner = (runner: string, args: string[], timeoutMs: number, cwd: string) => Promise<string>

function section(output: string, name: "STDOUT" | "STDERR"): string {
  const i = output.indexOf(`\n${name}\n`)
  if (i < 0) return ""
  const rest = output.slice(i + name.length + 2)
  const j = rest.indexOf(`\n${name === "STDOUT" ? "STDERR" : "STDOUT"}`)
  return j < 0 ? rest : rest.slice(0, j)
}

export async function liveSmoke(
  raw: LiveSmokeInput,
  ledgerPath: string,
  specPath: string,
  projectRoot: string = process.cwd(),
  runner: Runner = (r, a, t, c) => runTests(r, a, t, undefined, undefined, c)
): Promise<string> {
  const input = LiveSmokeInputSchema.parse(raw)
  const { ledger } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
  const unit = ledger.phases[input.phase]?.units[input.unit_id]
  if (!unit) return toKeyValue({ status: "error", error: "unit_unknown", hint: `unit '${input.unit_id}' is not registered in phase '${input.phase}'; delegate first` })
  const attempt = unit.attempt_seq ?? 0
  if (attempt === 0) return toKeyValue({ status: "error", error: "no_attempt", hint: "a smoke binds to an attempt; record the delegation first" })

  const { contract, error } = await unitContract(specPath, input.unit_id)
  if (error) return toKeyValue({ status: "error", error: "contract_invalid", detail: error })
  if (!contract) return toKeyValue({ status: "error", error: "contract_missing", hint: `no \`\`\`foreman-contract block names unit '${input.unit_id}' in ${path.basename(specPath)}` })
  const plan = contract.contract.smoke
  if (!plan) return toKeyValue({ status: "error", error: "smoke_null", hint: `unit '${input.unit_id}' declares smoke: null (reviewed: no external contract); nothing to run` })
  if (plan.id !== input.plan_id) return toKeyValue({ status: "error", error: "plan_unknown", hint: `unit '${input.unit_id}' registers smoke plan '${plan.id}', not '${input.plan_id}'` })

  const missingEnv = plan.env.filter((name) => !process.env[name])
  if (missingEnv.length) return toKeyValue({ status: "error", error: "credential_missing", env: missingEnv.join(","), hint: "set these in the server environment; values are never read into the ledger" })

  const harnessBefore = await digestPaths(projectRoot, plan.harness_files)
  const inputsBefore = await digestPaths(projectRoot, plan.input_files)
  if (harnessBefore.missing.length) return toKeyValue({ status: "error", error: "harness_missing", files: harnessBefore.missing.join(","), hint: "every harness file in the plan must exist; a missing harness is a broken plan, not an empty one" })

  const cwd = path.resolve(projectRoot, plan.cwd)
  if (path.relative(projectRoot, cwd).startsWith("..")) return toKeyValue({ status: "error", error: "cwd_outside_root" })
  const started = new Date().toISOString()
  const output = await runner(plan.runner, plan.args, plan.timeout_ms, cwd)
  const finished = new Date().toISOString()

  const harnessAfter = await digestPaths(projectRoot, plan.harness_files)
  const inputsAfter = await digestPaths(projectRoot, plan.input_files)
  const exit = /^exit_code:\s*(-?\d+)/m.exec(output)
  const exitCode = exit ? Number(exit[1]) : null
  const timedOut = /^timed_out:\s*true/m.test(output)
  const refused = output.startsWith("error:")
  const stdout = section(output, "STDOUT")
  const observations: string[] = []
  const failed: string[] = []
  if (refused) failed.push(output.split("\n")[0].slice(0, 200))
  if (timedOut) failed.push(`timed out after ${plan.timeout_ms} ms`)
  if (exitCode === null || exitCode === -1) failed.push("the runner did not start or was aborted")
  else if (exitCode !== plan.checks.exit_code) failed.push(`exit ${exitCode} (expected ${plan.checks.exit_code})`)
  else observations.push(`exit ${exitCode}`)
  if (plan.checks.stdout_contains !== undefined) {
    if (stdout.includes(plan.checks.stdout_contains)) observations.push(`stdout contains ${JSON.stringify(plan.checks.stdout_contains)}`)
    else failed.push(`stdout does not contain ${JSON.stringify(plan.checks.stdout_contains)}`)
  }
  if (plan.checks.stdout_not_contains !== undefined && stdout.includes(plan.checks.stdout_not_contains)) failed.push(`stdout contains ${JSON.stringify(plan.checks.stdout_not_contains)}`)
  if (harnessAfter.sha256 !== harnessBefore.sha256) failed.push("harness files changed during the run")
  if (inputsAfter.sha256 !== inputsBefore.sha256) failed.push("application inputs changed during the run")

  const receipt: SmokeReceipt = {
    run_id: createHash("sha256").update(`${started}${input.unit_id}${attempt}${plan.id}`).digest("hex").slice(0, 16),
    ts: finished,
    attempt,
    plan_id: plan.id,
    contract_sha256: contract.contract_sha256,
    harness_sha256: harnessBefore.sha256,
    input_sha256: inputsBefore.sha256,
    exit_code: exitCode,
    timed_out: timedOut,
    stdout_sha256: createHash("sha256").update(stdout, "utf-8").digest("hex").slice(0, 16),
    observations,
    passed: failed.length === 0,
    ...(failed.length ? { failed } : {}),
  }
  let ledgerNote = ""
  try {
    await recordSmoke(ledgerPath, input.phase, input.unit_id, receipt)
  } catch (err) {
    ledgerNote = err instanceof Error ? err.message : String(err)
  }
  return toKeyValue({
    status: receipt.passed ? "pass" : "fail",
    phase: input.phase,
    unit_id: input.unit_id,
    attempt,
    plan_id: plan.id,
    command: `${plan.runner} ${plan.args.join(" ")}`.slice(0, 300),
    cwd: plan.cwd,
    exit_code: exitCode ?? "n/a",
    timed_out: timedOut,
    harness_sha256: receipt.harness_sha256,
    input_sha256: receipt.input_sha256,
    contract_sha256: receipt.contract_sha256,
    observations: observations.join("; ") || "none",
    failed: failed.join("; ") || "none",
    recorded: ledgerNote ? `no (${ledgerNote})` : "yes (unit.smokes)",
    note: "Foreman ran the frozen plan through the project's runner on these bytes. set_verdict pass in a has_api phase requires a passing smoke for the current attempt whose harness and input digests still match; a newer failed run supersedes a pass.",
  })
}
