/**
 * live_smoke (0.6.22, architecture council 2026-09-10; deliverables 0.6.24, Codex
 * deliberation). Runs the UNIT'S OWN code path against the real system through the
 * project's real runner, and records a receipt the verdict gate reads. This is what turned
 * "94.6% coverage, six killed mutations, green suite, clean guard" into "cannot complete a
 * single HTTPS request": Foreman's HTTP client proves the endpoint; only the application's
 * transport proves the application.
 *
 * The call carries a plan id and nothing else. The command, working directory, required
 * environment names, harness inventory, application inputs, deliverables and checks come
 * from the plan registered in the spec's foreman-contract block, so a caller cannot
 * substitute `echo pass` for the harness. The receipt binds the current attempt, the
 * contract digest, a digest of the harness files, a digest of the application inputs and,
 * for every declared deliverable, the digest of the bytes the run produced and what Foreman
 * observed on them. set_verdict pass recomputes those digests and refuses when any moved.
 *
 * Deliverables (0.6.24): a declared output must be ABSENT before the run and present after
 * it, so "these bytes appeared during Foreman's run" is a fact and a pre-seeded compliant
 * file cannot stand in for the producer. Assertions are evaluated on the produced bytes;
 * a values_in reference is checked against the digest frozen on the delegation, so the
 * worker cannot rewrite the allowed set it is measured against.
 *
 * What this proves: Foreman executed the frozen recipe on these bytes at this time, saw this
 * result, and observed these properties on what appeared. What it does not prove: that the
 * harness honestly exercises production code, or that the properties are the right ones.
 * That is what harness review and the deliverable inventory are for.
 */
import path from "path"
import { createHash } from "crypto"
import fs from "fs/promises"
import { z } from "zod"
import { runTests } from "./runTests.js"
import { recordSmoke, type SmokeReceipt } from "../lib/ledger.js"
import { digestFile, digestPaths, digestReferences, evaluateDeliverable, readReferences, unitContract } from "../lib/specContract.js"
import { readLedgerWithStatus } from "../lib/ledger.js"
import { resolveNamedCredentials } from "../lib/foremanEnv.js"
import { toKeyValue } from "../lib/toon.js"
import type { DeliverableReceipt } from "../types.js"

export const LiveSmokeInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  plan_id: z.string().min(1).max(64),
})
export type LiveSmokeInput = z.infer<typeof LiveSmokeInputSchema>

type Runner = (runner: string, args: string[], timeoutMs: number, cwd: string, env: Record<string, string>) => Promise<string>

export interface LiveSmokeOptions {
  /** Override for `~/.foreman-mcp/.env`. Test seam. */
  credentialsPath?: string
}

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
  runner: Runner = (r, a, t, c, e) => runTests(r, a, t, undefined, undefined, c, e),
  opts: LiveSmokeOptions = {}
): Promise<string> {
  const input = LiveSmokeInputSchema.parse(raw)
  const { ledger } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
  const unit = ledger.phases[input.phase]?.units[input.unit_id]
  if (!unit) return toKeyValue({ status: "error", error: "unit_unknown", hint: `unit '${input.unit_id}' is not registered in phase '${input.phase}'; delegate first` })
  const attempt = unit.attempt_seq ?? 0
  if (attempt === 0) return toKeyValue({ status: "error", error: "no_attempt", hint: "a smoke binds to an attempt; record the delegation first" })
  const delegation = unit.delegations?.find((d) => d.attempt === attempt)

  const { contract, error } = await unitContract(specPath, input.unit_id)
  if (error) return toKeyValue({ status: "error", error: "contract_invalid", detail: error })
  if (!contract) return toKeyValue({ status: "error", error: "contract_missing", hint: `no \`\`\`foreman-contract block names unit '${input.unit_id}' in ${path.basename(specPath)}` })
  // 0.6.24: the plan that runs is the plan the attempt was delegated under.
  if (delegation?.contract_sha256 !== undefined && delegation.contract_sha256 !== contract.contract_sha256) {
    return toKeyValue({ status: "error", error: "contract_changed", hint: `the spec contract for unit '${input.unit_id}' changed since attempt #${attempt} was delegated (${delegation.contract_sha256} -> ${contract.contract_sha256}); re-run preflight_check and re-delegate` })
  }
  const plan = contract.contract.smoke
  if (!plan) return toKeyValue({ status: "error", error: "smoke_null", hint: `unit '${input.unit_id}' declares smoke: null (reviewed: no external contract); nothing to run` })
  if (plan.id !== input.plan_id) return toKeyValue({ status: "error", error: "plan_unknown", hint: `unit '${input.unit_id}' registers smoke plan '${plan.id}', not '${input.plan_id}'` })

  const creds = await resolveNamedCredentials(plan.env, { credentialsPath: opts.credentialsPath })
  if (!creds.ok) return toKeyValue({ status: "error", error: "credential_store_invalid", detail: creds.message })
  if (creds.missing.length) return toKeyValue({ status: "error", error: "credential_missing", env: creds.missing.join(","), hint: "set these in the server environment or in ~/.foreman-mcp/.env (process env wins); values are never read into the ledger" })

  const harnessBefore = await digestPaths(projectRoot, plan.harness_files)
  const inputsBefore = await digestPaths(projectRoot, plan.input_files)
  if (harnessBefore.missing.length) return toKeyValue({ status: "error", error: "harness_missing", files: harnessBefore.missing.join(","), hint: "every harness file in the plan must exist inside the root; a missing harness is a broken plan, not an empty one" })
  if (harnessBefore.truncated || inputsBefore.truncated) return toKeyValue({ status: "error", error: "inventory_incomplete", hint: "the harness or input inventory exceeds what one digest can observe; narrow input_files to the code the smoke exercises" })

  // 0.6.24: deliverables must be absent before the run, and every reference must be the one frozen at delegation.
  const deliverables = contract.contract.deliverables
  for (const d of deliverables) {
    const before = await digestFile(projectRoot, d.path)
    if (before.exists) return toKeyValue({ status: "error", error: "deliverable_present_before", deliverable: d.id, path: d.path, hint: "a deliverable must not exist before the run so the bytes observed are the ones this run produced; remove stale outputs and run again" })
  }
  const refs = await digestReferences(projectRoot, contract.contract)
  if (refs.missing.length) return toKeyValue({ status: "error", error: "reference_missing", files: refs.missing.join(","), hint: "every values_in reference file must exist inside the root" })
  if (deliverables.some((d) => d.assertions.values_in)) {
    const frozen = delegation?.references
    if (!frozen) return toKeyValue({ status: "error", error: "reference_not_frozen", hint: `attempt #${attempt} was delegated before its values_in references were frozen; re-run preflight_check and re-delegate so the allowed set is bound to the attempt` })
    const moved = Object.entries(refs.digests).filter(([p, sha]) => frozen[p] !== sha).map(([p]) => p)
    if (moved.length) return toKeyValue({ status: "error", error: "reference_changed", files: moved.join(","), hint: "a values_in reference changed since delegation; the allowed set is frozen with the attempt and cannot be rewritten by the work it measures" })
  }

  const cwd = path.resolve(projectRoot, plan.cwd)
  if (path.relative(projectRoot, cwd).startsWith("..")) return toKeyValue({ status: "error", error: "cwd_outside_root" })
  const started = new Date().toISOString()
  const output = await runner(plan.runner, plan.args, plan.timeout_ms, cwd, creds.values)
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

  // Deliverables: produced, observed, evaluated.
  const references = await readReferences(projectRoot, contract.contract)
  const produced: DeliverableReceipt[] = []
  for (const d of deliverables) {
    const after = await digestFile(projectRoot, d.path)
    const problems: string[] = []
    if (!after.exists) problems.push("not produced by the run")
    else if (after.problem) problems.push(after.problem)
    else {
      const bytes = await fs.readFile(path.resolve(projectRoot, d.path))
      problems.push(...evaluateDeliverable(bytes, d.assertions, references))
    }
    produced.push({ id: d.id, path: d.path, sha256: after.sha256, bytes: after.bytes, passed: problems.length === 0, ...(problems.length ? { failed: problems } : {}) })
    if (problems.length) failed.push(`deliverable ${d.id}: ${problems.join("; ")}`)
    else observations.push(`deliverable ${d.id} ${after.bytes} bytes ${after.sha256}`)
  }

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
    ...(produced.length ? { deliverables: produced } : {}),
    ...(Object.keys(refs.digests).length ? { references: refs.digests } : {}),
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
    run_id: receipt.run_id,
    command: `${plan.runner} ${plan.args.join(" ")}`.slice(0, 300),
    cwd: plan.cwd,
    credentials: plan.env.map((n) => `${n} (${creds.sources[n]})`).join(", ") || "none",
    exit_code: exitCode ?? "n/a",
    timed_out: timedOut,
    harness_sha256: receipt.harness_sha256,
    input_sha256: receipt.input_sha256,
    contract_sha256: receipt.contract_sha256,
    deliverables: produced.length ? produced.map((p) => `${p.id}=${p.sha256 ?? "absent"} (${p.bytes} bytes, ${p.passed ? "pass" : "fail"})`).join("; ") : "none declared",
    observations: observations.join("; ") || "none",
    failed: failed.join("; ") || "none",
    recorded: ledgerNote ? `no (${ledgerNote})` : "yes (unit.smokes)",
    note: "Foreman ran the frozen plan through the project's runner on these bytes and observed the declared deliverables. set_verdict pass requires a passing smoke for the current attempt whose harness, input, deliverable and reference digests still match; a newer failed run supersedes a pass. A review that carries the gate cites run_id in record_review smoke_receipts.",
  })
}
