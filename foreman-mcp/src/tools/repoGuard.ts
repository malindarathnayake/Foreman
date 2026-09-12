/**
 * repo_guard (v0.6.10; hardened in v0.6.11) — the shared-tree ownership check as a tool.
 *
 * `snapshot` captures the repository state before an editing worker runs, together with
 * the authorized file set, and stores both on the unit's newest delegation. `compare`
 * re-reads the state afterwards, diffs it against that frozen baseline, and records the
 * outcome. Foreman writes both results, so a pass verdict can require a cleared guard
 * (lib/ledger.ts) without trusting the pit-boss's account of what it saw.
 *
 * Two rules make the recording honest, both added after an adversarial review reproduced
 * their absence: a baseline cannot be re-taken for an attempt that already has one, and
 * the authorized files are read from the snapshot rather than from the compare call.
 * Without them the model could re-baseline over a violation, or widen authorization after
 * the mutation, and pass.
 */

import path from "path"
import { attributeHeadMove, compareSnapshots, takeSnapshot } from "../lib/repoGuard.js"
import { JOURNAL_FILE, PROGRESS_STATE_FILE, foremanFileScope } from "../lib/foremanFiles.js"
import { readLedger, recordRepoGuard } from "../lib/ledger.js"
import { scrub } from "../lib/redaction.js"
import { toKeyValue } from "../lib/toon.js"
import type { RepoSnapshot } from "../types.js"

export interface RepoGuardInput {
  operation: "snapshot" | "compare"
  phase: string
  unit_id: string
  /** Scopes the line-ending probe only. NOT the allow-list; see `allowed_files`. */
  files?: string[]
  /**
   * The authorized file set: every path the brief lets the worker change. Frozen onto the
   * snapshot, and the only thing `compare` measures ownership against. Omitted, it falls
   * back to a correction's inherited set and then to `files`; an explicit `[]` declares a
   * worker that edits nothing. It is never silently empty (0.6.26).
   */
  allowed_files?: string[]
  max_entries?: number
  project_dir?: string
}

/**
 * The server's own file paths. Everything Foreman writes during a unit window is derived
 * from these (lib/foremanFiles.ts) and excluded from the comparison. They come from server
 * configuration only, never from tool input, so a caller cannot name a file to hide it. [CWE-863]
 */
export interface RepoGuardPaths {
  ledgerPath: string
  /** Default: <ledger dir>/.foreman-progress.json */
  progressPath?: string
  /** Default: <ledger dir>/.foreman-journal.json */
  journalPath?: string
  /** Default: the ledger's directory */
  docsDir?: string
}

export async function handleRepoGuard(
  input: RepoGuardInput,
  paths: RepoGuardPaths
): Promise<string> {
  const { operation, phase, unit_id } = input
  // Same source of truth as the .foremanenv probe and codex_agents_init: the directory
  // the server runs in, overridable for tests and multi-root hosts.
  const dir = path.resolve(input.project_dir ?? process.cwd())
  const ledgerDir = path.dirname(paths.ledgerPath)
  const scope = foremanFileScope({
    ledgerPath: paths.ledgerPath,
    progressPath: paths.progressPath ?? path.join(ledgerDir, PROGRESS_STATE_FILE),
    journalPath: paths.journalPath ?? path.join(ledgerDir, JOURNAL_FILE),
    docsDir: paths.docsDir ?? ledgerDir,
  })
  const scopeSize = scope.state.length + scope.fenced.length

  if (operation === "snapshot") {
    const existing = await currentGuard(paths.ledgerPath, phase, unit_id)
    if (existing) {
      // A second baseline would silently replace the first, discarding a recorded
      // violation with it. A new baseline belongs to a new attempt.
      return scrub(toKeyValue({
        operation: "snapshot",
        status: "refused",
        reason: `this attempt already has a baseline (recorded ${existing.snapshot_ts}${existing.result ? `, result ${existing.result}` : ", not yet compared"})`,
        hint: "a baseline is frozen for the life of an attempt; record a new delegation for the next attempt, or run compare against this one",
      }))
    }
    // 0.6.20: a correction's authorized set is frozen on the from_attempt baseline and the
    // ledger refuses any other (RANK CORRECTION, lib/ledger.ts). Copy it from the ledger when
    // the call omits it, so the set the model cannot change is also the set it need not retype.
    const inherited = await correctionBaseline(paths.ledgerPath, phase, unit_id)
    // 0.6.26 (field report 2026-09-11): `files` scopes the line-ending probe, `allowed_files`
    // IS the allow-list, and a caller who passed only `files` got authorized_files: 0 — after
    // which every edit the worker made was "outside the brief", a HARD STOP clearable only by
    // user_override. A guard that authorizes nothing fails OPEN into a refusal: it cannot
    // catch an ownership breach (everything is a breach) and it trains the owner to waive.
    // So the allow-list is never silently empty. `files` is the fallback, and a deliberate
    // read-only guard must say so with an explicit empty array.
    const readOnlyGuard = input.allowed_files !== undefined && input.allowed_files.length === 0
    let allowedFrom = "given"
    let allowed: string[]
    if (input.allowed_files?.length) allowed = input.allowed_files
    else if (readOnlyGuard) { allowed = []; allowedFrom = "declared empty (the worker edits nothing)" }
    else if (inherited) { allowed = inherited.snapshot.allowed; allowedFrom = `attempt #${inherited.attempt} (inherited)` }
    else { allowed = input.files ?? []; allowedFrom = "files (allowed_files was not given)" }
    const files = input.files ?? inherited?.snapshot.allowed ?? []
    const maxEntries = input.max_entries ?? inherited?.snapshot.entry_limit
    const outcome = await takeSnapshot(dir, files, allowed, maxEntries, scope)
    if (outcome.status !== "ok") {
      return scrub(toKeyValue({
        operation: "snapshot",
        status: outcome.status,
        reason: outcome.reason,
        note:
          outcome.status === "n/a"
            ? "no guard is recorded and the verdict is not gated on one; the protocol's shared-tree rules still apply by hand"
            : "nothing was recorded; resolve the cause and take the baseline again before spawning the worker",
      }))
    }
    // Checked AFTER takeSnapshot so the non-git `n/a` fail-open boundary still answers first:
    // outside a work tree the guard does not apply at all, and an allow-list it will never
    // use is not worth a refusal.
    if (allowed.length === 0 && !readOnlyGuard) {
      return scrub(toKeyValue({
        operation: "snapshot",
        status: "refused",
        reason: "the authorized file set is empty; this guard could only ever report a violation",
        hint:
          "pass allowed_files: [<every file the brief authorizes>] — that is the allow-list compare freezes. " +
          "`files` only scopes the line-ending probe. For a worker that edits nothing, pass allowed_files: [] explicitly.",
      }))
    }
    // 0.6.26: an authorized file that is already entirely NUL means the tree was destroyed
    // before this worker ran. Spawning onto it would have the worker "fix" a file whose
    // original content is gone, and the guard would clear, because the path is authorized.
    if (outcome.damaged.length > 0) {
      return scrub(toKeyValue({
        operation: "snapshot",
        status: "damaged",
        phase,
        unit: unit_id,
        zeroed_files: outcome.damaged.join(", "),
        reason: "these authorized files are non-empty and entirely NUL bytes; that is a destroyed file, not a written one",
        note:
          "Nothing was recorded and no worker should be spawned. Restore them (git checkout / git restore) and take the baseline again. " +
          "A zeroed file still has its size and mtime, and a grep on it reports a missing symbol rather than a missing file.",
      }))
    }
    const { snapshot } = outcome
    const { attempt } = await recordRepoGuard(paths.ledgerPath, phase, unit_id, {
      snapshot,
      snapshot_ts: new Date().toISOString(),
    })
    return scrub(
      toKeyValue({
        operation: "snapshot",
        status: "recorded",
        phase,
        unit: unit_id,
        attempt,
        authorized_from: allowedFrom,
        root: snapshot.root,
        branch: snapshot.branch,
        head: snapshot.head.slice(0, 12),
        stash: `${snapshot.stash_ref.slice(0, 12)} (${snapshot.stash_count} entries)`,
        changed_paths: snapshot.entries.filter((e) => e.code !== "  ").length,
        entry_limit: snapshot.entry_limit ?? 0,
        authorized_files: snapshot.allowed.length,
        foreman_files: outcome.foreman_files,
        ...(outcome.foreman_files === 0 && scopeSize > 0
          ? { note: "Foreman paths resolve outside this repository root; Foreman's own writes will be charged to the worker" }
          : {}),
        autocrlf: snapshot.autocrlf,
        hash: snapshot.hash,
      }) +
        "\nNEXT\n  Spawn the worker, then call repo_guard { operation: 'compare', phase, unit_id }.\n" +
        "  The authorized files are frozen on this baseline; compare takes no allowed_files of its own.\n" +
        "  The pass verdict for this attempt is refused until that comparison clears."
    )
  }

  // compare
  const before = await currentGuard(paths.ledgerPath, phase, unit_id)
  if (!before) {
    return scrub(toKeyValue({
      operation: "compare",
      status: "no_baseline",
      phase,
      unit: unit_id,
      hint: "no snapshot is recorded on this unit's newest delegation; a comparison with no baseline proves nothing",
    }))
  }
  if (input.allowed_files && input.allowed_files.length > 0) {
    return scrub(toKeyValue({
      operation: "compare",
      status: "refused",
      reason: "allowed_files is accepted on snapshot only",
      hint: "the authorized set is frozen before the worker runs; widening it afterwards would clear the worker's own mutation",
    }))
  }

  const outcome = await takeSnapshot(dir, input.files ?? [], before.snapshot.allowed ?? [], before.snapshot.entry_limit, scope)
  if (outcome.status !== "ok") {
    return scrub(toKeyValue({
      operation: "compare",
      status: outcome.status,
      reason: outcome.reason,
      note: "no result was recorded, so the pass verdict stays blocked; resolve the cause and compare again",
    }))
  }

  // 0.6.27 (field report): committing the ledger at every verdict is the protocol, and a HEAD move
  // between snapshot and compare is a violation — both rules are right and they collided. A commit
  // carries the paths it touched, so a move whose whole range is Foreman-owned is attributable.
  const headMove = before.snapshot.head !== outcome.snapshot.head
    ? await attributeHeadMove(dir, before.snapshot.head, outcome.snapshot.head, outcome.scope)
    : undefined
  const violations = compareSnapshots(before.snapshot, outcome.snapshot, outcome.scope, headMove)
  // 0.6.26: a zeroed authorized file is invisible to the ownership diff — the path IS
  // authorized, so a destroyed file clears exactly like an edited one. It carries the
  // violation weight (the pass verdict stays blocked) under its own name and its own cause.
  for (const f of outcome.damaged) {
    violations.unshift(`authorized file is entirely NUL bytes — destroyed, not edited: ${f}`)
  }
  const result = violations.length === 0 ? "ok" : "violation"
  const { attempt, reopened } = await recordRepoGuard(paths.ledgerPath, phase, unit_id, {
    result,
    violations: violations.slice(0, 20).map((v) => v.slice(0, 400)),
    ...(outcome.damaged.length ? { damaged: outcome.damaged.slice(0, 20) } : {}),
    baseline_hash: before.snapshot.hash,
  })

  const head = toKeyValue({
    operation: "compare",
    status: result,
    phase,
    unit: unit_id,
    attempt,
    baseline_hash: before.snapshot.hash,
    current_hash: outcome.snapshot.hash,
    violations: violations.length,
    ...(outcome.damaged.length ? { zeroed_files: outcome.damaged.join(", ") } : {}),
    ...(headMove?.attributable ? { head_advanced: `${headMove.commits} commit(s), Foreman files only — attributed, not a violation` } : {}),
  })
  if (result === "ok") {
    return scrub(head + "\nThe worker touched nothing outside the frozen authorized set. The pass verdict is clear to proceed.")
  }
  return scrub(
    head +
      (reopened ? "\nThe unit's pass verdict was reopened to pending: a standing pass cannot outlive its guard.\n" : "") +
      "\nVIOLATIONS\n" +
      violations.map((v) => `  - ${v}`).join("\n") +
      "\n\nHARD STOP\n" +
      "  Repository state is user-owned. Do not attempt automatic recovery and do not run the tests.\n" +
      "  Preserve the evidence and escalate to the owner. The pass verdict for this attempt is refused\n" +
      "  until a later comparison clears, or the owner waives it with user_override on set_verdict."
  )
}

/** The frozen baseline of the attempt a correction extends, if the newest delegation is a correction. */
async function correctionBaseline(
  ledgerPath: string, phase: string, unitId: string
): Promise<{ attempt: number; snapshot: RepoSnapshot } | undefined> {
  const ledger = await readLedger(ledgerPath, { readOnly: true })
  const delegations = ledger.phases[phase]?.units[unitId]?.delegations ?? []
  const latest = delegations.at(-1)
  if (!latest?.correction) return undefined
  const from = delegations.find((d) => d.attempt === latest.correction?.from_attempt)
  return from?.guard?.snapshot ? { attempt: from.attempt, snapshot: from.guard.snapshot } : undefined
}

/** The guard on the unit's newest delegation, if any. */
async function currentGuard(ledgerPath: string, phase: string, unitId: string) {
  const ledger = await readLedger(ledgerPath, { readOnly: true })
  const delegations = ledger.phases[phase]?.units[unitId]?.delegations ?? []
  return delegations.length > 0 ? delegations[delegations.length - 1].guard : undefined
}
