/**
 * repo_guard (v0.6.10) — the shared-tree ownership check as a tool.
 *
 * `snapshot` captures the repository state before an editing worker runs and stores it
 * on the unit's newest delegation. `compare` re-reads that state afterwards, diffs it
 * against the stored baseline, and records the outcome. Both results are written by
 * Foreman, so a pass verdict can require a cleared guard (lib/ledger.ts) without
 * trusting the pit-boss's account of what it saw.
 */

import path from "path"
import { compareSnapshots, takeSnapshot } from "../lib/repoGuard.js"
import { readLedger, recordRepoGuard } from "../lib/ledger.js"
import { toKeyValue } from "../lib/toon.js"

export interface RepoGuardInput {
  operation: "snapshot" | "compare"
  phase: string
  unit_id: string
  files?: string[]
  allowed_files?: string[]
  project_dir?: string
}

export async function handleRepoGuard(
  input: RepoGuardInput,
  paths: { ledgerPath: string }
): Promise<string> {
  const { operation, phase, unit_id } = input
  // Same source of truth as the .foremanenv probe and codex_agents_init: the directory
  // the server runs in, overridable for tests and multi-root hosts.
  const dir = path.resolve(input.project_dir ?? process.cwd())

  if (operation === "snapshot") {
    const outcome = await takeSnapshot(dir, input.files ?? [])
    if (outcome.status === "refused") {
      return toKeyValue({
        operation: "snapshot",
        status: "refused",
        reason: outcome.reason,
        note: "file paths are placed on a git command line; a path that is absolute, escapes with '..', or starts with '-' is refused",
      })
    }
    if (outcome.status === "n/a") {
      return toKeyValue({
        operation: "snapshot",
        status: "n/a",
        reason: outcome.reason,
        note: "no guard is recorded and the verdict is not gated on one; the protocol's shared-tree rules still apply by hand",
      })
    }
    const { snapshot } = outcome
    const { attempt } = await recordRepoGuard(paths.ledgerPath, phase, unit_id, {
      snapshot,
      snapshot_ts: new Date().toISOString(),
    })
    return (
      toKeyValue({
        operation: "snapshot",
        status: "recorded",
        phase,
        unit: unit_id,
        attempt,
        branch: snapshot.branch,
        head: snapshot.head.slice(0, 12),
        stash: `${snapshot.stash_ref.slice(0, 12)} (${snapshot.stash_count} entries)`,
        staged_files: snapshot.staged.length,
        dirty_files: snapshot.dirty.length,
        autocrlf: snapshot.autocrlf,
        hash: snapshot.hash,
      }) +
      "\nNEXT\n  Spawn the worker, then call repo_guard { operation: 'compare', phase, unit_id, allowed_files: [<the brief's files>] }.\n" +
      "  The pass verdict for this attempt is refused until that comparison clears."
    )
  }

  // compare
  const ledger = await readLedger(paths.ledgerPath, { readOnly: true })
  const unit = ledger.phases[phase]?.units[unit_id]
  const delegations = unit?.delegations ?? []
  const latest = delegations.length > 0 ? delegations[delegations.length - 1] : undefined
  if (!latest?.guard) {
    return toKeyValue({
      operation: "compare",
      status: "no_baseline",
      phase,
      unit: unit_id,
      hint: "no snapshot is recorded on this unit's newest delegation; a comparison with no baseline proves nothing",
    })
  }

  const before = latest.guard.snapshot
  const allowed = input.allowed_files ?? []
  const outcome = await takeSnapshot(dir, input.files ?? [])
  if (outcome.status !== "ok") {
    return toKeyValue({
      operation: "compare",
      status: outcome.status === "refused" ? "refused" : "n/a",
      reason: outcome.reason,
      note: "the baseline stands; re-run the comparison once git is reachable, or escalate to the owner",
    })
  }

  const violations = compareSnapshots(before, outcome.snapshot, allowed)
  const result = violations.length === 0 ? "ok" : "violation"
  const { attempt } = await recordRepoGuard(paths.ledgerPath, phase, unit_id, {
    result,
    violations: violations.slice(0, 20),
    allowed_files: allowed.slice(0, 50),
  })

  const head = toKeyValue({
    operation: "compare",
    status: result,
    phase,
    unit: unit_id,
    attempt,
    baseline_hash: before.hash,
    current_hash: outcome.snapshot.hash,
    violations: violations.length,
  })
  if (result === "ok") {
    return head + "\nThe worker touched nothing outside the brief. The pass verdict is clear to proceed."
  }
  return (
    head +
    "\nVIOLATIONS\n" +
    violations.map((v) => `  - ${v}`).join("\n") +
    "\n\nHARD STOP\n" +
    "  Repository state is user-owned. Do not attempt automatic recovery and do not run the tests.\n" +
    "  Preserve the evidence and escalate to the owner. The pass verdict for this attempt is refused\n" +
    "  until the comparison clears, or the owner waives it with user_override on set_verdict."
  )
}
