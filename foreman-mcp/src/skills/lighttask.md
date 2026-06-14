---
name: foreman:lighttask
version: 0.0.1
description: Lightweight surgical-task protocol. Uses workspace classification, git context, spec freshness, grounding, mandatory adversarial review, and a small execution checklist without full Foreman ceremony.
---

# Lighttask

Run bounded, evidence-first work for surgical tasks that need more rigor than ordinary planning but do not justify the full design -> spec -> implement pipeline.

Use `lighttask` when the task is 1 to a few PRs, has cross-layer effects, touches an existing system, or includes judgment calls that should be grounded before implementation.

Do not use `lighttask` for one-line edits with no behavioral risk, large multi-phase features, or architecture decisions spanning systems. Escalate those to direct edit, full Foreman, or design partner respectively.

## Core Rules

| Rule | Requirement |
|---|---|
| Ground first | Do not plan from memory when files, specs, git state, or external systems can be checked. |
| Atlas is not truth | A project atlas may guide navigation, but final claims require direct grounding. |
| Atlas refresh is gated | Ask before generating or updating atlas files; user may skip and continue with `[UNVERIFIED]` atlas coverage. |
| Git is optional | Use git context when available; never panic in document folders. |
| No automatic mutation | Do not run `git init`, switch branches, or alter files unless the user approves. |
| Bypass is visible | User may bypass freshness or grounding gates, but affected outputs stay marked `[UNVERIFIED]`. |
| Adversary required | Run an independent advisor pass before execution unless the user explicitly waives it. |
| Small artifacts | Prefer one `Docs/lighttask.md` or `docs/lighttask.md` tracker over the full four-doc Foreman set. |

{{include: uncertainty-protocol}}

{{include: advisor-grounding}}

## Outputs

Default artifact:

```text
Docs/lighttask.md
```

Use `docs/lighttask.md` instead when the repo already uses lowercase `docs/`.

The artifact contains:

- Workspace classification
- Git context and waiver status
- Spec freshness result
- Atlas provider, status, and refresh decision
- Grounding report
- Plan checklist
- Decisions and notes
- Deliberation summary
- Error recovery log
- Session log

## Phase 0: Workspace Classification Gate

Before any git prompt or spec freshness gate, classify the current folder.

| Classification | Signals | Behavior |
|---|---|---|
| `repo` | `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.sln`, `pom.xml`, `build.gradle`, `src/`, `tests/`, `Docs/.foreman-*`, `docs/spec/` | Run Git Context Gate. |
| `document_workspace` | Many `.docx`, `.pdf`, `.md`, `.txt`; no source manifest; path such as Documents or Downloads; task is summarize/write/reorganize docs | Do not ask to initialize git. Continue with file-based grounding. |
| `ambiguous` | Mixed signals or shallow folder | Continue non-git unless the task needs durable planning/spec freshness. Ask at most one question if blocked. |

Non-git document workspace rule:

```text
Git context unavailable. Continuing with file-based grounding.
```

Do not ask users running in Documents, Downloads, or note folders to initialize git unless they explicitly request project-level change tracking.

## Phase 1: Git Context Gate

If the folder is a git repo, use read-only git checks:

```text
git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
git branch --show-current
```

If upstream data is available and useful, inspect ahead/behind status read-only.

Record:

- current branch
- current commit
- dirty status
- upstream, if known
- whether the spec was generated from another branch or commit

Branch mismatch behavior:

```text
Current checkout does not match the spec context.

Current:
  branch: <branch>
  commit: <commit>

Spec generated from:
  branch: <branch>
  commit: <commit>

Recommended action:
  switch to <branch> before planning.

Proceed options:
  1. Switch branch
  2. Stay here and run grounding against current checkout
  3. Bypass and continue with stale context
```

Rules:

- Never switch branches automatically.
- Never suggest a branch as authoritative unless it comes from recorded spec metadata.
- If the worktree is dirty, warn before any branch switch suggestion.
- Similar branch names may be hints only, not recommendations.

Non-git repo-like behavior:

```text
This looks like a project folder, but it is not a git repo.
Initialize git so Foreman can track spec freshness and branch context?
```

If the user skips:

- continue planning
- mark repo context as `non_git_skipped`
- do not claim commit provenance
- rely on mtimes, cited evidence paths, and direct grounding reads
- log `git_context_skipped`

## Phase 2: Spec Freshness Gate

Look for `spec-man` outputs:

```text
docs/spec/SPEC.md
docs/spec/API.md
docs/spec/DATA_CONTRACTS.md
docs/spec/ACCEPTANCE.md
docs/spec/spec.machine.json
docs/spec/<feature-or-subsystem>/SPEC.md
docs/spec/<feature-or-subsystem>/spec.machine.json
```

Also accept `Docs/` variants when the project already uses uppercase `Docs/`.

Freshness states:

| State | Meaning |
|---|---|
| `current` | Spec exists, schema is known, git context matches or is not applicable, cited evidence still exists. |
| `stale` | Referenced files/contracts/tests changed after spec generation, git commit differs, schema version changed, or source evidence is missing. |
| `missing` | No spec-man marker or machine spec found. |
| `partial` | Some relevant specs exist but the requested quadrant is not covered. |

Staleness checks:

- `spec.machine.json` missing when machine planning is needed
- schema is not `spec-man.machine.v1`
- spec source older than files it cites
- git diff touches files, contracts, tests, or configs referenced by the spec
- package, config, schema, migration, API, or route files changed after generation
- atlas quadrant touched by the request has no evidence map
- Graphify or another atlas provider exists but `graphify-out/` is older than changed source, docs, schema, config, or contract files
- open questions block the requested task

Bypass behavior:

| User choice | Planner behavior |
|---|---|
| Refresh spec | Run or request `spec_man` before planning. |
| Ground current checkout | Verify relevant facts directly and continue. |
| Bypass | Continue, log waiver, mark affected claims `[UNVERIFIED]`, include stale-spec warning in advisor prompts. |

Do not produce `ready-for-implementation` status after bypass unless the user explicitly accepts the risk.

### Atlas Refresh and Plan Re-evaluation

Treat Graphify as the preferred project atlas when `graphify` is installed or `graphify-out/` exists.

Atlas refresh is optional but should be offered when:

- starting or resuming in a repo whose branch, commit, dirty files, source files, docs, schema, config, or contracts changed after spec generation
- `spec-man` output is stale, partial, missing cited evidence, or lacks the requested quadrant
- the task needs broad source investigation before direct file reads can be scoped
- the existing plan was built from a different checkout, old atlas, or unknown repo context

Read-only discovery:

```text
where graphify
dir graphify-out
```

Potential refresh command after user approval:

```text
graphify update . --no-cluster
```

If no atlas exists and the task justifies one, offer to create it. If Graphify is missing, continue with direct grounding unless the user asks to install it. Use `graphify <path>` or semantic extraction modes only after explicit user approval because they may use an AI/API backend.

Re-evaluation flow:

1. Invoke or request `spec_man` in re-evaluation mode with current git context, plan refs, spec refs, atlas refs, and task scope.
2. Have `spec_man` classify the current plan as `current`, `needs_patch`, `blocked`, or `superseded`.
3. If the plan is `needs_patch` or `superseded`, run the Plan Delta Ladder: `D3 raw` -> `D2 grouped` -> `D1 candidate` -> `D0 current`.
4. Show the `D1` candidate delta, not every raw inconsistency, and ask the user to accept material changes before editing.
5. If the user skips atlas refresh, continue only with direct reads and mark atlas-derived claims `[UNVERIFIED]`.
6. If atlas output and direct evidence disagree, direct evidence wins and the mismatch goes into `D3 raw`.

Plan Delta Ladder behavior:

- `D3 raw` stores sealed findings from code, docs, tests, APIs, data, runtime, advisors, and Atlas checks.
- `D2 grouped` dedupes and groups findings by behavior, contract, subsystem, risk, or acceptance criterion.
- `D1 candidate` is the minimal revised plan delta for review.
- `D0 current` is the accepted plan state used for implementation.
- After promotion to `D0`, carry refs to lower rings instead of their full text.
- Prefer `D2` groups that map to implementation action surfaces. Keep stale tests, config/feature flags, contracts, migrations, and legacy helpers separate when they need separate edits.
- `D1 candidate` must list which `D2` groups it resolves or defers.

## Phase 3: Grounding Report

Before plan drafting, produce facts only.

Required format:

```markdown
## Grounding Report
- [VERIFIED] <fact>. Evidence: `<file:line>` or `<command>`
- [UNVERIFIED] <claim>. Missing: <specific source>
- [MISMATCH] <specified vs observed difference>. Evidence: <refs>
```

No opinions. No recommendations. No implementation plan.

If the task depends on DB, API, queue, cloud, or external runtime behavior, probe the central seam if credentials/tools are available. If unavailable, mark the fact `[UNVERIFIED]` or stop if it blocks correctness.

## Phase 4: Plan Draft

Draft the smallest execution plan that satisfies the grounded facts.

**Optional — visualize the change.** When the change crosses components or alters data/control flow, call `preview_diagram({ id, source })` to show the affected flow live for the user. Do NOT render for one-file edits, copy changes, dependency bumps, or purely local fixes. **For refactors, render a before/after pair** (ids like `<name>-before` and `<name>-after`) so the user can compare the current structure against the target before you start — this is the highest-value moment to align on the plan.

Format:

```markdown
## Current Status
<where the task stands>

## Pending Decisions
| Decision | Options | Blocking |
|---|---|---:|

## Decisions and Notes
| Decision | Choice | Evidence |
|---|---|---|

## Checklist
| Unit | Change | Files | Verification |
|---|---|---|---|

## Error Recovery Log
| Date | Unit | Error | Recovery | Status |
|---|---|---|---|---|
```

Rules:

- Do not autonomously choose non-trivial tradeoffs.
- Units should be independently verifiable.
- Verification must name a command, file inspection, API probe, or manual check.
- If scope grows beyond a few units, recommend full Foreman.

## Phase 5: Mandatory Adversarial Review

Run advisor review before execution unless explicitly waived.

{{include: deliberation-protocol}}

Lighttask advisor prompt:

```text
Review this lighttask grounding report and plan against the actual codebase.
Find false assumptions, stale spec usage, missing call sites, wrong repo conventions,
unsafe git/context assumptions, test gaps, and implementation steps that cannot work.
Use file:line evidence where possible. Classify each finding by severity.
```

Moderator duties:

- Verify every advisor finding against files or tools.
- Classify each as `AGREE`, `DISAGREE`, or `NUANCE`.
- Normalize severity.
- Revise the plan.
- Ask user to arbitrate unresolved tradeoffs.

If no advisor is available, ask for a waiver. Do not silently proceed.

## Phase 6: Execute

Execute units one at a time.

For each unit:

1. Re-read the files to be changed.
2. Make the smallest scoped edit.
3. Run the unit verification command.
4. On failure, log the error and recover with a different approach.
5. On success, mark the unit complete in `Docs/lighttask.md`.

Use direct implementation only when the unit is small enough for the current operator. Use a worker when the unit needs isolation or broader edits.

{{include: error-handling-standard}}

## Quality Bar

Lighttask is ready to execute when:

- Workspace classification is recorded.
- Git context is recorded, skipped, or explicitly unavailable.
- Spec freshness is `current`, refreshed, grounded against current checkout, or bypassed with waiver.
- Atlas state is recorded when an atlas exists, was refreshed, was skipped, or was unavailable.
- Grounding report contains only cited facts and explicit unknowns.
- Pending decisions are resolved or intentionally deferred.
- Adversarial review is complete or waived.
- Every checklist unit has a verification method.
- Bypass and uncertainty are visible in the final plan.

## What This Skill Does NOT Do

- It does not replace full Foreman for multi-week work.
- It does not treat a project atlas as authoritative truth.
- It does not initialize git, switch branches, or modify files without approval.
- It does not produce polished public documentation. Use `doc_man`.
- It does not define intended behavior from scratch when requirements are missing. Use `spec_man`.
