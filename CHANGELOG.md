# Changelog

## 0.6.21 - 2026-09-10

A third field report and a Codex deliberation over the designs (gpt-6-astra, adversarial). One design was vetoed and two shipped defects were found in 0.6.20 code.

- **Fixed in shipped code.** The fence check never fired through the real tool path: recording the snapshot rewrites the ledger, and the ledger was one of the marked files, so `stateMoved` was always true; marks now cover the progress-state file only, with a test through `repo_guard`. The preflight lookup let an earlier pass survive a later failure and let a pass on one unit satisfy another; the newest record for a brief decides and a unit's records are its own. `verify_oracle` overwrote a file blindly on restore; it now refuses when the file holds neither the mutation nor the original, runs each guard configuration unmutated first (a red baseline invalidates every mutation under it, never a kill), classifies timeouts and aborted runs as invalid, warns when no guard argument names the mutated file's directory, and runs in the repository root (`run_tests` gained a working directory).
- **Typed attempt outcomes.** `close_attempt { attempt, outcome: delivered | blocked | validation_only, note }` labels a non-failure ending once; a rejection or fail verdict marks the attempt `rejected` and that label is server-authored and cannot be relabelled. Lifetime counters live on the unit because the delegation history is trimmed. Attempt ids, the failure cap, `needs_attempt`, the guard and the verdict are untouched.
- **Worker heartbeats.** Workers append `{ts, phase, unit, attempt, files, note}` to `.foreman-heartbeat.jsonl` beside the ledger, a Foreman-owned file the guard excludes and never a fence mark; `worker_status` reports the newest heartbeat for the unit's current attempt, files touched so far, and stale lines from earlier attempts. Advisory. The delegation result now names the attempt.
- **Per-unit phase ownership.** `phase_ownership` sweeps every unit against its own Files column and assigns each outside reference to the unit whose Files hold it, or UNASSIGNED; the report carries a hash and says it is stale once a unit lands. Sites are classed `at_risk` (a dispatch site with a default arm that names none of the introduced members), `present` (a member is already named there: reassurance) or `reference`; at_risk rows come first, since for an introduced member presence is the handled case and absence at a dispatch site is the risk. The compile probe waits for an isolated execution primitive.
- **Contract probe.** `contract_probe` sends a GET or HEAD from Foreman's own HTTP client, resolves header values from environment variable names it never prints, evaluates explicit assertions (2xx, exact status, min bytes, contains, non-empty JSON path so a 200 with zero rows fails), and records origin, path, status, bytes and body hash on the unit. In a phase whose scope declares `has_api`, `preflight_check` refuses a brief until the unit has a passing probe; the requirement comes from the phase scope, not a caller flag.
- **Two actors, one tree.** `pitboss_paths` was vetoed: content cannot attribute a write to an actor, and an exemption would have widened what delta review leaves unchecked. Instead the protocol says the pit-boss does not write Docs/ or the harness while a worker window is open, records discoveries with `record_fact`, amends after the verdict, and closes a validation-only re-check as `validation_only`.

## 0.6.20 - 2026-09-10

Two field reports in one day, eleven items, all built. The attestation-shaped ones became checks.

- **Preflight is checked, not attested.** `preflight_check { phase, unit_id, brief, symbols, files, type_names?, introduces? }` compares the brief against the spec before the attempt is spent: every symbol in `symbols` must appear in the spec and every citation in the brief (path, file:line, named test) must resolve in the repository, or it refuses; directive sentences with no echo in the brief, contradiction markers, drifted citations with their real line, and files outside the declared set that reference the type the unit extends (dispatch sites with a `default:` arm first) are reported as advisories. It returns a `brief_hash` and writes a record beside the ledger; once a project has run it, `set_unit_status s:'delegated'` refuses a brief whose hash has no passing record (`PREFLIGHT RECEIPT`). `symbols_grepped` is an array now; the old count is still read.
- **A mutation primitive.** `verify_oracle { phase, unit_id, mutations: [{ label, file, old, new, runner, args }] }` applies each mutation, runs the guard test through run_tests, restores the file and verifies the restore by hash. Killed, survived (the suite cannot observe that control) and invalid are reported and recorded on the unit; a failed restore aborts loudly.
- **Probe check: discover before you escalate.** A gap about how something outside the repository behaves is answered by docs for the exact version plus a side-effect-free probe before it can be classified. The pit-boss answers a fixed block (docs, what would answer it, side effects, credentials, cost, decision); `PROBE NOW` when side-effect-free with a held credential, `ASK ONE LINE` when a side effect or missing credential needs the user, `OWNER DECISION` only for policy, ownership, cost, scope and security wording. Included by the implementor, design partner, spec generator and lighttask.
- **Saved Workflow scripts on Claude Code.** `claude_workflows_init` installs `foreman-checkpoint-review`, `foreman-design-panel` and `foreman-triage` into the project's `.claude/workflows/`. A run is confirmed with the user unless the session opted in; a workflow review is same-model perspective; implementation never runs inside a workflow.
- **`native` review opens to Claude Code.** A Workflow fan with distinct agents and a verifier is the shape `stage:'native'` models; the basis stamp labels it same-provider and the independence bound caps the streak, so it no longer reopens what 0.6.13 closed. Cursor and generic still refuse it.
- **repo_guard no longer charges the worker for Foreman's own writes.** One module, `lib/foremanFiles.ts`, names every state file (ledger, progress, journal, events, seats), their `.corrupt.<ts>` backups and atomic-write `.tmp` files, and Docs/PROGRESS.md is fingerprinted with Foreman's fenced block stripped rather than excused. A fenced-block change that arrives with no Foreman progress write is still a violation.
- **Review staleness keys per unit.** A seat review stays current for the units whose attempt did not change; the gate demands fresh coverage only for the units that moved, by a later seat or an eligible verification. Legacy records without a snapshot stay whole-phase keyed.
- **Same-worker reuse works mid-unit.** The correction write binds the worker id onto the previous attempt when it carries none, same session, recorded as late-bound; every other correction predicate is unchanged.
- **Nit path.** A post-gate test-assertion nit took eight writes; it takes four plus the gate: `set_unit_status` with an inline `rejection`, snapshot inheriting the frozen set, compare, `set_verdict` with `escape_class`.
- **Soft limits.** Journal messages, review `checked` entries, `limitations` and native reviewer `checked` entries are truncated with a visible marker and a warning instead of refusing the whole write.
- **Smaller.** `run_tests` accepts a pinned toolchain path inside the project root whose basename is an allowed runner. Model ids keep their rank when the host appends a context suffix such as `[1m]`. `T_BLIND` names a green suite that cannot observe the defect. `write_progress retire_unit` removes an orphan checklist entry with a reason. `write_ledger record_fact` keeps bounded per-phase facts gathered during preflight, listed by `read_ledger { query: "facts" }`.

## 0.6.19 - 2026-09-09

- Review outcomes. The seat rule at the phase gate is unchanged; what carried each counted pass is now recorded. Every counted pass is stamped with a basis class (receipted external, declared external, same-provider, a delta variant, or override), its seats, the per-unit attempt snapshot, every waiver accepted, the declared rank and a token split, with scalar totals per basis that survive the bounded history. `read_ledger { query: "review_outcomes" }` recomputes the table on every read.
- Escapes. A rejection, a non-pass verdict, or a new attempt on a unit its gate still covers records an escape against that gate; coverage keys on the attempt snapshot, so a pass-to-pass re-verdict cannot exit it. The class is a closed enum the ledger demands before the unit's next pass verdict and before the phase's next counted pass; `record_escape` classifies, or records a defect found out of band; `add_rejection { escape_class }` classifies in the same write. Phases gated before this release attribute to `legacy`.
- Seat receipts. `invoke_advisor` appends a hash-chained receipt for every run (vendor from the CLI, served model, exit code, failure reason, prompt hash, bytes, tokens) and returns `seat_receipt` and `packet_sha256`. `record_review` binds one receipt to one independent record after checking the file: packet hash equal, run succeeded, unspent, and after the newest verdict and attempt. A foreign-vendor receipt on a host with a known vendor is `receipted_external`; a same-vendor receipt is `same_provider`.
- Independence bound. Three consecutive counted passes carried by same-provider review, an override, or (on Codex) an unreceipted independent record are the limit; the next is refused until a receipted cross-vendor seat resets the streak or the owner overrides on the record. Records from earlier releases are neutral.
- Worker-delta records gain structural bounds: the verifier must be a fresh id against every baseline native agent and every worker in the phase, `checked` must list every file in `evidence.files`, and a baseline carries at most two verification records (a server scalar, not a count over trimmable history). The Top-only admission condition is unchanged; legacy records keep the 0.6.18 predicates.
- `invoke_council` writes one receipt per seat with the vendor from a prefix allowlist over the configured model id, else `unknown`, which the basis classes as `receipted` and never as external. `review_outcomes` ends with the owner-review triggers (T1 a basis losing seat status on defect escapes, T2 unreceipted external gates on Codex, T3 the reviewer-rank precondition, T4 independence overrides), and `scripts/review-outcomes.mjs` renders the same table across N ledgers.
- The review predicates moved out of `ledger.ts` into `reviewPredicates.ts` unchanged; the outcomes logic lives in `reviewBasis.ts` and `seatReceipts.ts`. A 19-agent deliberation rejected a rank-weighted review scheme because Foreman has no source for the model a native reviewer ran on; rank never enters review sufficiency.

## 0.6.18 - 2026-09-09

- Declared workflow rank. The pit-boss reports its model and reasoning effort at `init_session` (or later via `write_journal declare_model`), and Foreman resolves a rank from an explicit allowlist of host-emitted ids and display names; unknown ids stay on the normal protocol. Middle rank permits same-worker mechanical corrections with a compact follow-up; Top rank additionally permits bounded fixes, focused intermediate validation, and a `worker_delta` verification with a verifier distinct from every correcting worker. Every correction is a new recorded attempt bound to the same worker and journal session, stays inside the previous frozen authorized file set, and requires a cleared ownership guard; hot-path and security-boundary phases are excluded. Seat reviews now snapshot per-unit attempt counts, so a review is current only when no unit has a newer attempt. Direct Fix is legacy-only: the pit-boss no longer writes code, fixes, or tests. Rank is a trusted self-declaration by design; it never changes agent_class, seat capability, or cost tier, and never waives workers, guards, or checkpoint gates.
- Reconciles 0.6.13 and 0.6.16: a same-model fan was recorded but never counted as a seat; a complete native review with distinct reviewers, distinct lenses, and a separate verifier now satisfies the Codex gate, labelled as same-provider review. Legacy `fan` records are not promoted.

## 0.6.17 - 2026-09-09

- All host profiles now show the same ledger-derived state in `read_progress` and `session_orient`, including passed/remaining units and phase gates. Checklist totals are labeled separately and no longer claim project completion or choose a competing next unit. Declared units count toward remaining work, and progress reads leave corrupt files untouched.

## 0.6.16 - 2026-09-09

- Codex mode now defaults to native workers and a review team of distinct reviewers plus a verifier. Complete `stage: "native"` evidence can satisfy its phase gate without external CLIs or a review override; stale, incomplete, and confirmed findings remain blocking.
- Major checkpoints add whichever Claude/Gemini advisors are available through the existing tools. Missing optional providers do not block native review, and native evidence is labelled as same-provider review.
- Host procedures, diagnostics, role instructions, and MCP validation now describe the native path; legacy fan records and other hosts retain their gate policy.

## 0.6.15 - 2026-09-09

Codex host only. `claude-code`, `cursor` and `generic` are untouched, and a test asserts they never see the new seats.

- **The pit-boss picks an implementation seat per unit** instead of using one seat for everything. `codex_agents_init` now writes `worker_light`, `worker` and `worker_heavy` alongside the existing roles.
- **Each seat is pinned to a model verified by live probe** on codex-cli 0.153.4: `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra`. The version is load-bearing rather than cosmetic — `gpt-6-terra` and `gpt-6-sol` are both refused on a ChatGPT account, so a model family does not travel across a version bump and a newer-looking id is not automatically available. `CODEX_SEAT_MODELS` is the single source of those defaults and the `models` input still overrides any of them per role, because ids rotate.
- **The seat maps onto Foreman's existing cost tiers**, which are already recorded on every delegation with a `route_reason`. Light is for a fully specified edit: a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern. Standard is the default, for ordinary implementation where the brief states the behaviour and the seat chooses the code, and it is where anything unclassifiable belongs. Heavy is for concurrency, migrations, error-handling semantics, public contracts or schemas, security and authorization paths, and any unit a lower seat already failed.
- **Escalation stays bound to the rule that already existed**: a fix worker moves up a tier only when `route_reason` cites the rejection, a refined brief, or an advisor diagnosis. Starting at premium to save a round is called out as the thing not to do.
- The light seat is told to stop and ask for a stronger seat rather than guess when a brief turns out to need judgement; the heavy seat is told the brief's file list still binds, so extra reasoning goes into failure modes rather than scope.
- **The unverified `gpt-5.6-luna` reference is gone** from both the invoke and fan-out text. It had been carried since 0.5.7 with a hedge attached and never confirmed.
- **Reasoning effort is not pinnable per role in this build.** Rather than invent a config field, the text says to pass effort at spawn time when Codex exposes it — high for light and standard, xhigh for heavy — and never to assert an effort the host did not apply.
- `host_status` reports the Codex seat table rather than a single model slug scraped from prose, which no longer carries one.
- Bumped package to `0.6.15`.

## 0.6.14 - 2026-09-09

Foreman compresses `run_tests` and `invoke_advisor` output before the pit-boss reads it, and the pit-boss reads the failing `file:line` and the exit code out of exactly that text to reach a verdict. The only guard on the compressed digest was that a retrieval marker survived and the output was non-empty, so a digest could drop every location in a failure report and still be served.

- **A protected-literal check now compares the original against the text actually served.** A critical literal lost entirely, or invented from nothing, discards the digest and serves the original unchanged; the reason goes to stderr. Nothing is ever rewritten.
- **Which classes gate was decided by measurement, not taste.** Compressing this repository's own 5,000-line test fixture keeps 4 of 4 paths and drops 103 of 103 incidental `45ms`-style timings. Dropping bulk repetition is the compressor's whole purpose, so gating on every class would reject honest work and gating on none would leave the original hole. Locations, paths and the exit code gate; everything else is counted for diagnosis. A repeated literal deduplicated to a lower non-zero count is allowed, because the value is still recoverable.
- **The check runs after the meta head is re-prepended**, not on the raw digest. Foreman puts the exit code back itself, so checking earlier failed every compression for losing a literal Foreman was about to restore.
- A file extension must start with a letter, so an address such as `127.0.0.1:5432` is not read as a source location and its absence does not block a digest.
- Bumped package to `0.6.14`.

## 0.6.13 - 2026-09-09

Codex host only. When a phase checkpoint needs an advisor review and neither the Claude nor the Gemini CLI is reachable, the last rung used to be two adversarial self-review passes in the pit-boss's own seat. On Codex that is one context talking to itself. It now runs a **review fan** on Codex's own subagents instead.

- **`reviewer` and `verifier` join `codex_agents_init`.** Both are read-only, both are forbidden from writing files, spawning further agents, or producing a ledger verdict. The reviewer answers one risk lens and nothing else; the verifier is told in its own instructions that the findings it receives came from the same model it is running on, so they are claims to test rather than evidence.
- **The fan is three steps.** Spawn one `reviewer` per lens, picking three to five from the versioned catalog that match the change; they run in parallel under `agents.max_threads`, each seeing only its lens question and the evidence it needs, and never each other's output. Then spawn one `verifier`, hand it every finding, and require it to open each cited `file:line`, classify `confirmed` / `rejected` / `unverified`, re-rate severity by blast radius, merge duplicates across lenses, and return one report. Then record it. `max_depth=1` still holds throughout.
- **The orchestrator's context stays clean.** The reviewers do the reading, which is the expensive part, and only the verifier's report comes back to the main thread. A finding the verifier drops is gone, which is why its instructions say so explicitly.
- **A fan is perspective, not independence, and the ledger says so.** `record_review` accepts a new `stage: 'fan'`. It is stored with its findings, its examined list, and a `limitations` note naming which advisor CLIs were unavailable — and, like `cross_exam`, it never counts as a seat for the phase gate. The `REVIEW REQUIRED` message names it and points at the owner's decision. Separate contexts and one lens each remove shared reasoning; they do not decorrelate one model's blind spots, and pretending otherwise would buy a green gate with nothing behind it. A confirmed finding recorded by a fan still blocks the gate exactly like any other.
- The practical change for a Codex run with no advisor CLI: the same owner arbitration the protocol already required at that rung, now with a verified, lens-covered report attached instead of a self-review.
- Bumped package to `0.6.13`.

## 0.6.12 - 2026-09-09

`repo_guard` was unusable on any repository larger than this one, reported from the field the day after it shipped.

- **The index fingerprints are read for the changed paths, not the whole index.** They came from an unscoped `git ls-files -s`, which emits a row per *tracked file*, so its output scales with repository size rather than with the change being compared. It measured 13 KB against the 16 KB capture limit in this repo, which is why every test here passed, and it refused every snapshot on a larger repository with `output exceeded the capture limit`. The call is now scoped to the paths `git status` actually reported, batched by argument length so a long command line cannot fail on Windows.
- **The changed-path limit is a default, not a wall.** `max_entries` on `snapshot` defaults to 500 and is raisable to 5000; `compare` reuses whatever the baseline was taken under, so both sides are measured the same way. A tree that legitimately carries more changes than the default can still be guarded by asking for a bigger comparison, and the truncation message now says so instead of only reporting that it gave up.
- **Git output budgets are sized from that limit.** `runExternalCli` takes an optional `maxStdout` with a 2 MB ceiling. The default stays 16 KB, which is the right budget for advisor and test output because that is prose a model reads; a machine-readable inventory of changed paths is a different thing, and truncating one silently is a correctness bug rather than a display one.
- Regression test: a repository whose full index exceeds the capture limit now snapshots correctly for a one-file change. That is the case the original test suite could not see, because both the temporary repositories it built and this repository fit under the limit.
- Bumped package to `0.6.12`.

## 0.6.11 - 2026-09-08

An adversarial review of 0.6.10 broke the repository guard in nine ways, each reproduced against a real repository before it was accepted. The headline defect: the comparison diffed **path sets**, so a file that was already dirty before the worker ran was still dirty afterwards, and a worker overwriting the user's uncommitted work in a file outside the brief returned `ok`. That is the exact loss the guard exists to prevent, so this release reworks the model rather than patching the symptoms.

- **The comparison sees content, not just paths.** Every changed path carries a fingerprint for both the work tree (sha256 of the bytes) and the index (the staged blob id). An already-dirty file whose content or staged blob changed outside the authorized set is now a violation, as is a change to its status.
- **An unreadable tree is a refusal, never a clean one.** Every git probe is checked for exit status, timeout, and output truncation. Before, a failing `status` contributed an empty dirty list, so a corrupt index produced a clean-looking snapshot and an unauthorized edit compared green. A missing HEAD, a missing stash ref, and an unset config remain states, not failures. A failed comparison records nothing, so the verdict stays blocked.
- **The baseline and the authorized set are frozen.** A second `snapshot` for the same attempt is refused, because re-taking it replaced a recorded violation and then passed. `compare` no longer accepts `allowed_files`, because widening authorization after the worker ran cleared the worker's own mutation. Both were reproducible ways to retry until the guard turned green.
- **Paths round-trip correctly.** Status is read NUL-delimited with `-uall` and `core.quotepath=false`. Untracked directories expand to individual files instead of collapsing to `src/`, which had hidden new files inside them and falsely flagged authorized ones. Unicode and spaced names survive, and a file literally named `x -> a.ts` is no longer parsed as a rename and authorized as `a.ts`.
- **The snapshot records the repository root.** `project_dir` is caller-supplied, and a clean clone with the same HEAD could clear the real tree; a comparison run against a different checkout is now a violation.
- **Foreman's own state files are excluded.** The pit-boss writes progress, journal, and ledger during a unit, so counting them as worker mutations reported a violation on every real run.
- **A recorded violation outlives its attempt.** Matching only the current attempt let a violation be abandoned by allocating another one, since a direct fix bumps `attempt_seq` without adding a delegation. A violation now also reopens a standing pass to `pending`, the way a rejection does: a pass must not outlive its guard.
- **Truncation blocks only on real overflow**, and the entry cap is 200. Fifty unchanged dirty files previously blocked a repository that had done nothing wrong. An authorized repair that restores committed content is allowed, instead of being reported as destroyed work.
- Tool responses are scrubbed through the redaction path. `tests/repoGuard.test.ts` carries a case for every defect above and drives real git repositories throughout.
- Bumped package to `0.6.11`.

## 0.6.10 - 2026-09-08

An advisor review named Foreman's ceremony as its biggest weakness, and singled out bookkeeping that the protocol asks a model to perform by hand. The repository guard was the clearest case: two paragraphs of prose telling the pit-boss to run six git commands before an editing worker, hold the result in conversation context, and compare by eye afterwards. A compaction between those two points destroyed the baseline silently, and nothing was recorded, so a skipped check and a passed check looked identical in the ledger.

- **`repo_guard` (27th tool) runs the shared-tree ownership check.** `snapshot` captures branch, HEAD, stash ref and count, staged and dirty paths, `core.autocrlf`, and `git ls-files --eol` for the unit's files, and records them on the unit's newest delegation. `compare` re-reads the same state after the worker returns and names every mutation outside `allowed_files`: a moved HEAD, a file staged or unstaged, a changed stash, a changed `core.autocrlf`, a file changed outside the brief, or a pre-existing uncommitted change that disappeared. The order is `set_unit_status s:'delegated'` → snapshot → spawn → compare.
- **A pass verdict needs a cleared guard.** `set_verdict v:'pass'` is refused for an attempt whose delegation carries a snapshot with no comparison, or with a comparison that found violations (`REPOSITORY GUARD`). Foreman writes both the snapshot and the result, so the check is a fact about the tree rather than the pit-boss's account of one. `user_override` waives it and is recorded on the delegation as `guard_override`.
- **Scoped so nothing existing breaks.** Enforcement applies only to a delegation that actually carries a snapshot. Outside a git work tree, or with git unavailable, the tool reports `n/a` and gates nothing, the same fail-open rule the `.foremanenv` refusal probe already follows. Ledgers written before this version, hosts that never call the tool, and a re-delegation whose new attempt has no snapshot are all unaffected.
- **[CWE-88]** file paths reach a git command line, so every path is validated and the list is always placed after a `--` separator. A path that is absolute, escapes with `..`, or begins with `-` is refused before anything is spawned.
- Two bugs found by running the guard against real repositories rather than reasoning about it: the git helper trimmed whole command output, which ate the leading status column of `git status --porcelain` and returned every path missing its first character; and a test that flipped `core.autocrlf` was a no-op against a machine whose global value was already set. Both are covered by regressions in `tests/repoGuard.test.ts`, which drives real git repositories throughout.
- The implementor's shared-tree preflight and repository-state guard steps are now two tool calls instead of two paragraphs. Tool count 27.
- Bumped package to `0.6.10`.

## 0.6.9 - 2026-09-08

Field-feedback round 6: the paid review loop at the phase gate. A pit-boss on another project ran six review rounds (two seats each, well over a million advisor tokens) on one phase because every LOW fix re-verdicted a unit, which staled the review, which demanded a fresh seat. Codex (`gpt-6-astra`) replayed the ledger against the diagnosis and found four enforcement holes; all four are closed here, and two of the proposed fixes (a non-gating `accepted` classification, a diff-only "delta" seat) were rejected as loopholes and did not ship.

- **`REVIEW REQUIRED` says whether the verification path is open.** The gate error now ends with `VERIFICATION ELIGIBLE` and the exact `record_review { stage: "verification", ... }` shape to write, baseline timestamp and direct-fix attempts filled in, or `VERIFICATION NOT ELIGIBLE` with the one blocker. The check runs the same predicates the gate applies to a submitted record, and also confirms that recording the verification would not evict its own baseline.
- **A verification baseline must be a complete seat.** A `completion: failed` or `partial` review, or a silent one (zero findings, no `checked[]`), can no longer anchor a `stage: verification` record. Before, the failed record went stale after the direct-fix re-verdict, the INCOMPLETE check stopped seeing it, and the gate passed with no completed independent review.
- **Every attempt since the baseline must be a direct fix.** A worker delegation, or an `invoke_worker` attempt in the sidecar, recorded between the baseline review and the final literal fix is refused. Before, only the unit's current attempt was inspected, so a behaviour-changing worker attempt sandwiched between two reviews received no seat.
- **Retention never evicts a record the gate is blocking on.** The 20-record cap stays, but a current review with a confirmed finding, an unsuperseded failed or silent seat, a current verification record, and the baseline it names are never dropped; oldest evictable records go first. Before, twenty clean reviews appended after a confirmed HIGH pushed it out of history and the gate passed with no waiver.
- **A failed or silent seat is superseded by re-running it.** A later `completion: complete` record from the same advisor at the same stage clears the INCOMPLETE REVIEW block; a different advisor, a cross_exam, or another incomplete record does not, and a confirmed finding on the superseded record still blocks. Before, the only ways past a timed-out seat were a re-verdict (which staled every review) or an owner override.
- Implementor checkpoint text names the hint and the re-run rule. New regression file `tests/fieldFeedback2026-09e.test.ts` mirrors each replayed sequence.
- Bumped package to `0.6.9`.

## 0.6.8 - 2026-09-05

- **The Codex seat runs `gpt-6-astra` at `xhigh`.** Verified through the CLI first: codex-cli 0.152.0 answers "requires a newer version of Codex" for this id and refuses every other `*-astra` spelling outright on a ChatGPT account; 0.153.4 runs it and echoes `model: gpt-6-astra` and `reasoning effort: xhigh` in its header. `invoke_advisor` now reads that header and reports `model_served` and `reasoning_effort`; a model other than the pinned one is a failed seat (`model_substituted`), the same rule as the Gemini seat. Needs codex-cli 0.153.4 or newer.
- Bumped package to `0.6.8`.

## 0.6.7 - 2026-09-04

- **The Gemini seat is pinned to `gemini-3.1-pro-preview`, and the served model is checked.** 0.6.6 pinned `gemini-3.8-flash` on the strength of a probe that only proved the id was accepted. The run stats told the truth: on that account the CLI served `gemini-3.5-flash` for the main request, silently, with exit 0 and a plausible answer, and did the same for `3.7-flash`. `gemini-3.1-pro-preview` is served faithfully and the API defaults Pro to thinking level `high`. `invoke_advisor` and `capability_check` now run gemini with `--output-format json`, read `model_served` and the thinking tokens from the stats, and treat a served model other than the pinned one as a failed seat (`model_substituted`), text kept for the record. Non-JSON output from an older CLI is handled as before with `model_served: unknown`.
- Bumped package to `0.6.7`.

## 0.6.6 - 2026-09-04

- **The Gemini advisor seat runs `gemini-3.8-flash`.** `invoke_advisor` and `capability_check` pass the model id directly instead of `arch-review`, an alias that existed only in one machine's `~/.gemini/settings.json` (mapped to `gemini-3.1-pro-preview`) and could not resolve anywhere else. Verified through the CLI before the change: the id answers, and an unknown id fails with `ModelNotFoundError`, so the answer is not a silent fallback.
- Gitleaks allowlist: the two aider fixture tokens are back. They live on in history after the file's removal in 0.6.3, and gitleaks scans every commit.
- Bumped package to `0.6.6`.

## 0.6.5 - 2026-09-04

Field-feedback round 5: six items from a fifth Fable 5.1 pit-boss run, validated by an adversarial Codex pass that overturned two of the proposed fixes.

- **A silent advisor seat is a failed seat.** `invoke_advisor` reports exit 0 with empty stdout, or with stdout equal to the prompt, as `completion: failed` with the reason and the stderr tail, keeping the child's exit code. The checkpoint protocol records it with the reason in `limitations`, retries once, and treats a second failure as an unavailable seat. No retry inside the tool, so the wasted call stays visible.
- **Drift blocks only on a contradiction.** `session_orient` used to compare the progress file's first-open pointer to the ledger target as strings, so a pending entry for a later unit stopped the next session on a false alarm that no write could clear. `state_drift` now fires only when the progress file marks a unit complete that the ledger has not passed, or has units while the ledger has no phases. Stale, ahead, and orphan entries go to a new non-blocking `progress_advisories` field. The pit-boss's natural-order proposal was rejected: it still false-stopped on stale progress and compared unrelated id schemes.
- **One owner decision past the cap.** `authorize_attempts { attempts, reason, user_override: true }` records a grant of up to ten further attempts on a capped unit; each later delegation or direct fix is charged to it, `session_orient` shows `attempt_grants`, the unit view shows the grant, and a pass closes it. Refused below the cap, while a grant is open, and together with `user_override` on one write (`AMBIGUOUS OVERRIDE`). Per-write `user_override` remains the fallback.
- **`cross_exam` never satisfies the gate.** Review currency counted every current record, so a pit-boss cross-examination written after a re-verdict passed `REVIEW REQUIRED`. Currency now needs an independent review, or an eligible verification record; council payloads carry `stage: "independent"`.
- **`stage: "verification"` for direct-fix follow-ups.** A pit-boss record with structured evidence (baseline review, units and attempts, files, tests, probe) stands in for a fresh seat only when the baseline is a retained independent review, the phase is not `hot_path` or `security_boundary`, no confirmed finding above LOW was recorded since the baseline, every re-verdicted unit passed `via: "pitboss-direct"` with a direct-fix record at its current attempt, the evidence names that attempt, and the sidecar shows no `invoke_worker` delegation for it. `REVIEW REQUIRED` names the failed predicate.
- **`checked[]` entries up to 400 characters.**
- **Legacy checkbox lines are counted, not edited.** `complete_unit` reports `legacy_checkbox_candidates` for hand-written `- [ ] <unit id>` lines outside the fence and leaves them untouched: a tick could contradict the fenced line, nothing would untick it on a reopen, and the fence contract preserves outside content verbatim.
- Bumped package to `0.6.5`.

## 0.6.4 - 2026-09-04

Field-feedback round 4: five items from a fourth Fable 5.1 pit-boss run, triaged against the code and validated by an adversarial Codex pass. Codex overturned two of the proposed fixes and found the wider hole behind the first item.

- **The delegation cap guards the pass, not only the delegation record.** A pass verdict needs an attempt recorded after the latest rejection or fail verdict (`ATTEMPT REQUIRED`), and past the cap it needs `user_override`, recorded on the unit as `cap_override`. Fixing off the record after a `DELEGATION CAP` refusal no longer passes. The cap counts failed attempts since the unit last passed, so a unit reopened at three separate checkpoints is not treated as one non-converging series; the reporter's proposal to count only rejections on the same brief was rejected as caller-controlled text. A `fail` verdict counts as a failed attempt. A Direct Fix is recorded as an attempt through `set_unit_status { s: "ip", direct_fix }`, which the protocol already said it was. The counts live in server-written per-unit scalars (`attempt_seq`, `epoch_failed`, `last_failed_attempt`, `needs_attempt`) because `rej[]` and `delegations[]` drop their oldest entries at 20; the rejection stamp after the 21st delegation was wrong for the same reason and is fixed. Existing ledgers derive the scalars on the first write that touches a unit. `session_orient` reports `attempt_blocks`; the unit view of `read_ledger` shows the counters.
- **`record_review` requires a classification on every finding.** The gate blocks only on `confirmed`, so a real finding recorded without one slipped past it. Reviews recorded earlier with unclassified findings read as `INCOMPLETE REVIEW` at the gate.
- **`bundle_status` answers `restart_recommended` with `true`, `false`, or `n/a`.** The server snapshots `dist/`, `package.json`, and the stack profile override at process start; the tool compares disk against it and names what changed. A rebuilt or reinstalled package under the same version is `true`; `unknown` is gone.
- The limits the reporter hit are in the top-level tool descriptions: journal `msg` at 400 characters, review `checked` at 50 entries of 200 characters.
- Advisor Grounding Protocol: adversarial asks state the authorized verification goal and the bounded target; context-free "break / bypass" imperatives are avoided because some advisor CLIs refuse them; a refusal is recorded as `completion: "failed"`, retried once with bounded wording, and never treated as a clean review.
- One-call review recording was declined: classifications cannot be keyed before the model sees the parser's finding boundaries and `unparsed_lines`, and the saving is three calls of thirteen at a checkpoint, not half.
- Bumped package to `0.6.4`.

## 0.6.3 - 2026-09-04

Surface reduction, validated by an adversarial Codex pass before any cut (it rejected six of eight proposed trims; only the two below survived, plus the owner's rulings).

- **`aider_worker` removed.** The tool, its detached-worktree library, the Python harness, and their tests are gone; the failure taxonomy shrinks from 21 to 17 active stages. Sidecars written before 0.6.3 still read: the four aider-era stages are kept in a read-only legacy set so their historical refunded classification does not change. `.foremanenv` no longer accepts `aider-cli` as a worker kind, nor the `FOREMAN_NUM_CTX_*`, `FOREMAN_MAX_REFLECTIONS_*`, and `FOREMAN_REASONING_TAG_*` keys. Default tool count is 26 (27 under Codex).
- **The tarball ships only what the runtime reads.** `package.json` now carries a `files` whitelist: `dist/`, `src/skills/`, `HOST-CONTRACT.md`, the package README and LICENSE, and the bundled dependencies. `bench/`, `scripts/`, `tests/`, TypeScript sources, the `src/docs` and `src/preview` duplicates, the vendor tree, declarations, and source maps no longer ship. The build cleans `dist/` first so a removed module cannot keep shipping as stale output. A test pins the packed manifest.
- **Publish smoke gate extended.** Beyond `tools/list`, the installed package must activate a protocol from `src/skills`, serve the ethos document from `dist/docs`, contain exactly the runtime file set, and resolve its skills dir under `--diag`.
- **Journal codes trimmed to 15.** Twelve codes no protocol text or code path ever emitted, plus `CAP_WAIVER` (aider-only), are gone. Journals written earlier still parse.
- **Council regression.** A loopback test proves a configured `invoke_council` seat authenticates, streams, parses, and prints a `record_review` payload, so shared worker code can change without silently breaking the council.
- Bumped package to `0.6.3`.

## 0.6.2 - 2026-09-04

Documentation rewrite, two gate rules that closed holes the docs review exposed, and field-feedback round 3 (six items from a third Fable 5.1 pit-boss run, triaged by a fork subagent and validated by an adversarial Codex pass).

- README rewritten plain: what the server does in one paragraph, tarball-first install, `claude mcp add`, a copy-paste first prompt, and collapsible sections for what happens, what the ledger refuses versus what the procedure asks, the files it creates, cost, and egress. Docs site rebuilt to 16 pages in the same voice (name the actor; separate enforced from instructed; copy-paste prompts; exceptions in the same sentence as the rule); eleven abstract pages folded away; every stale fact found in the review corrected (tool counts, `gradle` in the allowlist, Codex editing concurrency, the forbidden full-ledger read at session start, the missing `preflight` in the enforcement example, Langfuse egress).
- Phase gate: a review counts only when recorded at or after the phase's latest unit verdict (a review that predates a re-verdict covered old code); the gate refuses while any such review carries a finding classified `confirmed` (`CONFIRMED FINDINGS`, override recorded as `confirmed_override`) or is `completion: partial` or `failed`, or has zero findings with no `checked` list and no `completion: complete` (`INCOMPLETE REVIEW`, override recorded as `incomplete_override`). A collapsed reviewer parse can no longer satisfy the gate as an empty review.
- Tool descriptions: hosts clip them at about 2,000 characters, which is exactly where the 0.6.0 generated shapes landed on `write_ledger`. The per-operation `data` shapes for the three write tools now live in the input schema's `data` property description, which hosts show in full; every description is held under the clip by a test. The `pitboss_implementor` description said G1–G5; it is G1–G6.
- `normalize_review` parses bounded item blocks: bold-wrapped numbered items, `Severity:` fields mid-line or on the next line, `— HIGH:` after a location, exact `[P0]`–`[P3]` levels, markdown tables, and consecutive headings without blank lines. A block still needs an explicit severity token to become a finding. The checkpoint prompt now asks advisors to start every finding with a bracketed severity.
- `bundle_status` reports `running_version` and `runtime_disk_version`, `restart_recommended: true` when they differ (compiled code cannot be reloaded; protocol Markdown is re-read on every activation), and which skills a project or user override shadows.
- Worktrees: the Claude Code fan-out rule and the host contract gain a line-endings clause (check `core.autocrlf` and `git ls-files --eol`, serialize when the repo cannot normalize, create worktrees with `core.autocrlf=false`, `git apply --check` before applying); `aider_worker` creates its detached worktree with `-c core.autocrlf=false`.
- `run_tests`: `gofmt` and `golangci-lint` in the default allowlist, plus `fail_on_stdout` for list-style checkers that exit 0 with work to do.
- Journal `msg` limit raised to 400 characters.
- Implementor gains a spec-amendment rule for `SPEC_GAP`: one atomic change across every affected document, one Decisions row, reopen a passed unit only when the amendment changes what it must do, material changes go to the owner or `spec_man`.
- Bumped package to `0.6.2`.

## 0.6.1 - 2026-09-03

Field-feedback round 2 (2026-09-03): six items from a second pit-boss run on a large project.

- Schema errors from `write_ledger`, `write_journal`, and `write_progress` are no longer raw Zod issue dumps. Each rejected call now returns one line per field (`data.via: Invalid option: expected one of "worker"|"pitboss-direct"|"n/a"`) followed by the expected data shape for that operation, rendered from the same schema constants the descriptions use.
- The Brief Preflight (Step 4.5) is now attested on the delegated write: `set_unit_status s:'delegated'` requires `data.preflight: { symbols_grepped: ≥1, self_consistent: true, telemetry?: 'checked'|'n/a' }` (checked after the brief rule, so existing messages are unchanged) and the attestation is stored on the delegation entry. The preflight is as mechanical as the pass rule instead of a mental checklist.
- Two journal event codes, both anomalies: `SPEC_GAP` (a spec gap resolved by pit-boss decision, recorded, run continued — `SPEC_AMB` keeps meaning "stopped, asking") and `GATE_OVERRIDE` (user forced past a phase checkpoint; the same journal session continues, `gate` names the phase). Enum is 28 codes.
- `invoke_advisor` no longer ships a 16k stderr transcript with a successful review. Truncation is tracked per stream; on success stderr is dropped unless stdout itself was cut, and then only a 40-line tail is kept. Failures keep stderr whole.
- `run_tests` gains opt-in output shaping: `strip_patterns` (≤10 regex sources, applied per line to both streams before the cap, `stripped_lines` reported) and `tail_lines`. Default output is byte-identical to 0.6.0.
- Bumped package to `0.6.1`.

## 0.6.0 - 2026-09-03

Field-feedback round (2026-09-02): eight friction items from a pit-boss run, triaged against the source and deliberated with an adversarial Codex pass; three deeper root causes surfaced in that deliberation are fixed here too.

- `normalize_review` no longer collapses a multi-finding review into one row. A finding now starts only at a recognized header — an explicit severity token in any common decoration (`HIGH:`, `[HIGH]`, `**HIGH**`, `**[HIGH]**`, `[**HIGH**]`, trailing `(HIGH)`), a `Severity:` field, or a `Finding N` heading — after Markdown list and heading prefixes are stripped. Unmarked prose (preambles, "what I checked" lists, "no findings") is counted in a new `unparsed_lines` field and never becomes a finding. Output adds a `findings_json:` line that is `record_review`-ready, escapes `|` inside the TOON table, and caps descriptions at the `record_review` limit.
- `write_journal` and `write_ledger` descriptions now carry the exact per-operation `data` shapes — every key, enum value, and limit — generated from the validation schemas (`lib/schemaDoc.ts`) and pinned by a listTools contract test, so an agent no longer discovers `target_version ≤ 20`, the 26-code event enum, or the eight `end_session.summary` fields one failed call at a time. The `set_verdict` line finally names `via` and `inconclusive`. The journal's anomaly-only contract is stated in the description (`TOOL_ERR` covers broken host tooling; there is deliberately no informational code).
- Rejecting a unit whose verdict is `pass` now reopens it to `pending` (returned as a `warning`). Previously `add_rejection` never touched the verdict, so a unit rejected at a checkpoint stayed gate-passable and invisible to `session_orient`'s `active_rejections`.
- The phase gate now refuses `g:'pass'` when the phase has no `record_review` entries; `user_override:true` passes without a review and is recorded on the phase as `review_override`. The check is sequenced last so every existing block message is unchanged.
- `session_orient` orders phase and unit ids naturally (`p2` before `p10`, `U0.9` before `U0.18`) — plain lexicographic sort resumed the wrong phase on projects with ten or more phases. `last_completed_unit` is now the completion frontier: the newest first-pass timestamp (`first_pass_ts`, stamped once by `set_verdict` and never overwritten), so re-verdicting an earlier unit after a checkpoint fix no longer moves it backwards. New additive fields `latest_pass_verdict_unit` / `latest_pass_verdict_ts` carry the temporal fact. The progress checklist uses the same ordering.
- `record_review` gains optional `completion` (`complete|partial|failed`), `checked` (what the seat examined), `limitations`, and `stage` (`independent|cross_exam`); `read_ledger reviews` renders them on zero-finding rows. The implementor checkpoint now requires each advisor to list what it examined per category, treats zero findings with no examined list as `partial` (never clean, no line-count floor), and records a targeted re-prompt as a separately-staged cross-examination that never counts as a second independent seat.
- Implementor Step 4.5 gains two brief-lint steps: brief self-consistency (a test expectation must not contradict the brief's own implementation instruction) and a custom-field telemetry reserved-name check against the active stack profile, with an explicit ambiguity rule when the profile resolved by fallback. The spec generator gains the matching G10 grounding check.
- Direct Fix: the pit-boss may apply a rejected unit's fix itself without a worker, but only for an exact literal substitution the rejection already spelled out (rename, typo, import path, test name, spec-literal constant) on a host-native-delegated unit, touching only the unit's files, adding no function/branch/test, and never on auth, secrets, telemetry names, contracts, schemas, concurrency, or error semantics. Recorded as `set_verdict via:'pitboss-direct'`; still an outer-loop attempt; units delegated through `invoke_worker`/`aider_worker` are ineligible because their sidecar chain would contradict the ledger.
- `PROGRESS.md` no longer ends up with two checklists: the spec generator emits an empty machine-owned fenced "Ledger Status" block (which `write_progress` fills from the ledger) and keeps the hand-written plan as a fence-free "Unit Plan" table. The `write_progress` description states the fence contract and the ledger-seeding dependency.
- The spec generator records `state_tracking_policy` (from a read-only `git check-ignore` over the Foreman state files) in the handoff and treats a commit instruction that contradicts the ignore rules as a grounding failure to escalate — it never creates or edits `.gitignore`.
- Bumped package to `0.6.0`.

## 0.5.14 - 2026-08-08

- Diagram preview viewer gained interaction controls: cursor-centered wheel zoom, drag panning, toolbar (zoom in/out, 100%, fit) with `+`/`-`/`0`/`f` keyboard shortcuts, and client-side export as PNG (2x, white background, canvas-limit capped), SVG, or the raw `.mmd` source. All rendering and export stay client-side under the existing strict CSP (PNG rasterizes through a `data:` URL; a tainted-canvas edge case falls back to SVG export). First render auto-fits oversized diagrams; live-reload preserves the current zoom/pan.

- Declared units are now a ledger fact: new `write_ledger` operation `declare_phase_units` records each phase's expected unit-id set (additive union-merge, cap 200, ids validated against TOON-structural characters). The phase gate blocks `g:'pass'` while any declared id is unregistered, and `session_orient` resumes at the first declared-but-unseeded unit (`action: implement_unit`, new `missing_declared_units` field) instead of misreporting `retry_phase_gate` on a partially-seeded phase — closes the field-reported hole where a quarter-implemented phase passed its gate mechanically.
- Declared sets are frozen behind a passed gate (reopen the gate first — no override), participate in the D2b gate-staleness hash when present (legacy hashes unaffected), and support auditable correction: `retire` removes declared-only ids with a mandatory reason tombstoned in `declared_log`. The progress checklist renders declared-but-unregistered units as unchecked `declared, unregistered` rows instead of erasing them.
- `session_orient` state-drift detection is now bidirectional: progress marking the ledger's resume unit itself complete is flagged as `progress:complete(<unit>);ledger:<target>`. Partial progress files (earlier phases only) remain non-drift, so later-phase resumes are not blocked.
- `read_ledger` paged queries emit a query-specific recovery `hint` when cells were truncated (verdict notes → per-unit read; rejections/reviews → phase-scoped `full`); untruncated output is byte-identical.
- Session-start protocol: implementor sessions probe advisors once and record `<version>/<auth_status>` in the `init_session` env (`null` now explicitly means "not probed"); checkpoints reuse the probe instead of re-running it.
- The claude-code worker fan-out rule replaces its vague isolation exception with a concrete procedure: parallel editing workers require `isolation: "worktree"`, disjoint editable sets, full `git diff` in each completion report, and serial per-unit application; the full worktree fan-out contract remains v0.6 HOST-CONTRACT scope.
- Bumped package to `0.5.14`.

## 0.5.13 - 2026-08-05

- Hardened shared-tree delegation after a production migration exposed a destructive `git stash` hazard: editing workers receive an explicit Git-mutation denylist, run sequentially unless isolated, and require a before/after branch, HEAD, stash, index, and dirty-path guard before tests or verdict. Foreman never performs automatic repository recovery.
- Made ledger reads safe on mature projects with phase/verdict filters, cursor pagination, bounded cells, notes omitted by default, and recovery guidance instead of oversized `full` output.
- Made `session_orient` the ledger-authoritative resume path, with explicit action and resume target, phase-gate retry detection, timestamp-based last-completed selection, and ledger/progress drift reporting. `read_progress` is now explicitly descriptive only.
- Added shell-free Gradle wrapper support to `run_tests`, including Windows execution through `GradleWrapperMain`, and allowed canonical string journal phase ids such as `V20-P0` while retaining legacy numeric input.
- Added a repeated-checkpoint termination protocol: targeted mutation or fault injection after a second green-but-unobservable block, defect-source classification, and mandatory owner arbitration after a third block.
- Bumped package to `0.5.13`.

## 0.5.12 - 2026-08-03

- Added `invoke_council` (EXPERIMENTAL): an adaptive review council that runs N remote read-only review seats across M risk lenses over one evidence packet, in parallel, and returns structured findings for the host to moderate and the user to arbitrate. Read-only by design — seats never edit the tree, apply fixes, or write the ledger, and findings come back ledger-shaped for `write_ledger record_review`.
- The council is entirely optional and its absence is a supported state, not an error: with no seats configured the tool returns `status: unavailable`, names the next rung of the deliberation ladder, and every other tool, skill, and ledger flow behaves exactly as before.
- Added a versioned 7-lens catalog (contract, architecture, state, security, data, tests, operability). Each seat receives the evidence packet plus ONE compact lens card; the catalog, other lenses, and provider details never enter a reviewer's context.
- Seats are configurable from the repo `.foremanenv` or from a new operator-owned store at `~/.foreman-mcp/.env`, with the home store overriding per seat so a model can be swapped without editing a shared repo file. Each seat reports which file configured it.
- `~/.foreman-mcp/.env` also serves as a credential store: an API key may live there instead of the process environment. For the API key the process environment wins; for council seats the home store wins.
- [CWE-522] The council resolves its API key from the same store that supplied its endpoint. A repo `.foremanenv` pointing at a local serving box while the home store seats the council on a hosted provider is the expected setup, and resolving those independently would misdeliver a credential in one direction or the other.
- [CWE-532] Every value in the home credential store that clears the redaction harvest guards is now registered for redaction. Previously only the single resolved `FOREMAN_API_KEY` was registered, so a second credential in that file was invisible to both `scrub()` and the outbound secret gate.
- Extracted the remote chat transport into `lib/chatTransport.ts`, shared byte-for-byte between `invoke_worker` and `invoke_council`: two-phase connect/activity timeouts, byte-capped streaming reads, and the closed status-to-failure-stage mapping now have one implementation. `invoke_worker` behavior is unchanged.
- Council requests stream (`stream: true`) so the connect budget measures the endpoint rather than a multi-minute reasoning generation, and the activity budget detects a genuine mid-generation stall. OpenRouter-native provider routing is sent only when the endpoint is actually OpenRouter.
- Deliberation protocol extended to a recorded 5-rung ladder (council → single seat → both CLI advisors → one advisor → two adversarial passes). `status: unavailable` and `status: fail` both drop a rung; neither is ever a passed review. Two seats on one model is disclosed as perspective, not independence.
- Added optional Langfuse tracing for council runs, vendored zero-dependency from crucible. Off unless `FOREMAN_LANGFUSE_*` is configured; content capture is separately gated and off by default; a tracing failure degrades to silence and never alters a review.
- Bumped package to `0.5.12`.

## 0.5.11 - 2026-07-28

- Migrated from the monolithic MCP TypeScript SDK v1 package to the stable split v2 packages (`@modelcontextprotocol/server` for runtime and `@modelcontextprotocol/client` for tests).
- Upgraded to Zod 4 Standard Schema objects for every tool registration and enabled stdio negotiation for both legacy MCP clients and the 2026-07-28 protocol era.
- Made every tool input contract strict (`additionalProperties: false`), promoted display titles to v2 top-level metadata, and added validated scalar output schemas plus `structuredContent` while retaining the existing text content for clients.
- Added wire-level regression coverage for modern negotiation, legacy fallback and scalar-output projection, invalid arguments, unknown tools, and split-package diagnostics.
- Fixed `--diag` to report the installed `@modelcontextprotocol/server` version instead of probing the removed v1 package.
- Kept release tarballs offline-installable by bundling the v2 server package and its runtime dependencies.
- Excluded the workspace-local `.tmp/` npm cache from release tarballs after package-content inspection caught it in the candidate archive.
- Documented the evidence-backed lean-runtime boundary: Foreman composes installed host tools; `aider_worker` uses isolated Git worktrees without executing `git stash`; host-native isolation remains host-enforced and makes no user-edit recovery guarantee.
- Bumped package to `0.5.11`.

## 0.5.10 - 2026-07-13

- Codex advisor reviews now run `gpt-5.6-sol` at `xhigh` reasoning effort (was `ultra`); regression coverage updated.
- `invoke_advisor` timeout budget raised for newer Sol-class thinking time: default 5 → 15 minutes, cap 10 → 30 minutes. A timed-out advisor was previously killed mid-reasoning and recorded as unavailable.
- Gitleaks allowlist: exact-token entries for the aider transport and foremanEnv test fixtures, plus a path allowlist for dojo ledger-snapshot sha256 content hashes (all false positives; CI secret scan green again).
- The aiderWorker "python missing" capability-probe test now skips on hosts where python cannot be hidden from PATH (e.g. GitHub Ubuntu runners, where /usr/bin hosts both python3 and git).
- Bumped package to `0.5.10`.

## 0.5.9 - 2026-07-12

- Fixed `run_tests` on Windows when `where npm` resolves first to Node's extensionless bash shim (`C:\Program Files\nodejs\npm`), which `spawn()` cannot execute and previously failed with `ENOENT`. Foreman now invokes the adjacent `npm-cli.js` with its current Node executable, without `cmd.exe` or shell interpolation.
- Windows runner resolution now prefers native `.exe`/`.com` candidates over extensionless shims. `.cmd`/`.bat` shims remain refused when no shell-free invocation exists.
- Bumped package to `0.5.9`.

## 0.5.8 - 2026-07-12

- Codex multi-agent orchestration (`--host=codex`): new `worker_fanout` host placeholder on all profiles; implementor Step 2 renders parallel spawn/wait/summarize with per-unit ledger `delegated` before spawn and `max_depth=1`.
- New `codex_agents_init` MCP tool (registered only when `host===codex`): writes `.codex/agents/explorer.toml` + `worker.toml` (overrides built-in roles to pin sandbox_mode); creates `.codex/config.toml` `[agents]` only when absent — never clobbers existing config; model pins are optional caller overrides.
- Release tarballs now bundle all runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, and `context-crush`) so local `.tgz` installation does not require npm registry access.
- Bumped package to `0.5.8`.

## 0.5.7 - 2026-07-10

- Replaced the broken Claude-Code alias in `--host=codex` with a native Codex profile: bounded workers use Codex `spawn_agent`, with `gpt-5.6-luna` recorded as a preference only when the host confirms that model selection.
- Added Claude as a first-class `capability_check` / `invoke_advisor` CLI. Codex-mode adversarial review now runs headless `claude-fable-5` at `max` effort with tools disabled and a one-dollar call budget, with Gemini as the second independent advisor.
- Removed provider names from the bundled implementor's pitboss, worker, and checkpoint rules. Advisor detection and invocation now render from the active host profile.
- Added an authoritative host-runtime preamble for project/user skill overrides so stale provider instructions cannot shadow current host routing. Claude CLI versions remain telemetry only and never gate compatibility.
- Clarified that Crucible is an optional future custom/local-model worker runner, not part of the normal Codex or Claude flow and not an owner of the frontier pitboss conversation.
- Bumped package to `0.5.7`.

## 0.5.6 - 2026-07-09

- Updated Codex review routing to `gpt-5.6-sol` with `ultra` reasoning effort.
- Updated the Cursor Advisor A profile to the matching `gpt-5.6-sol-ultra` model slug and added direct regression coverage for the Codex invocation arguments.
- Bumped package to `0.5.6`.

## 0.5.5 - 2026-07-08

- EXPERIMENTAL `aider_worker` (26th tool): a sibling of `invoke_worker` (forked, not an extension) that drives the aider Python CLI as a benchmarked local subagent. Preserves the #1 invariant — never mutate the tree, never apply from the worker tool — via an isolated-worktree→`git diff` apply model: the tool runs aider in an ephemeral worktree off the base commit (`use_git=False`, `auto_commits=False`), returns the diff verbatim between `-----BEGIN/END FOREMAN PATCH-----` sentinels plus `base_file_hashes`, and the host applies after the CAS staleness check (`ED_STALE`). Dirty base tree → `WORKER_DIRTY_TREE_REFUSAL` (refunded).
- aider transport is an external Python harness (`scripts/aider_harness.py`) spawned through the existing `lib/externalCli.ts` seam — no new Node runtime deps. A `capability_check`-style probe fails open with a recorded waiver when python/aider are absent (route falls back to `remote-chat`). Filtered child env keeps the API key off the child's environment (key travels via stdin only); harness stdout is isolated to a single metadata-only JSON object.
- New orthogonal `worker_kind` axis in `.foremanenv` (`remote-chat | aider-cli`), defaulting to `remote-chat` so existing v0.5.0 configs keep loading; `aider-cli` tiers require `FOREMAN_NUM_CTX_<T>`.
- Closed failure taxonomy extended 17 → 21 (`WORKER_BINARY_NOT_FOUND`, `WORKER_AIDER_EXIT`, `WORKER_AIDER_LLM_ERROR`, `WORKER_DIRTY_TREE_REFUSAL`), byte-shared between the `invoke_worker` PLAYBOOK and the events sidecar; all four new CLI stages are refunded (do not count against the per-model discipline scorecard).
- Server-side discipline-adherence gate in `lib/ledger.ts`: reconciles each pass-unit's ledger verdict against its latest hash-chained sidecar terminal outcome. Strict/fail-closed — only a terminal `validation_completed{outcome:'pass'}` is clean; every other terminal (including a refunded-infra failure on the latest delegation) blocks the phase gate unless a `user_override` is recorded in `discipline_overrides`. Native/Agent-delegated units with no sidecar delegation skip the gate.
- Deferred to the GPU serving host (advisory, never CI): the headroom-proxy wiring (P6) and the multi-model local bake-off (P8), which need the vLLM + aider serving environment.
- Bumped package to `0.5.5`.

## 0.5.2 - 2026-07-07

- Patch release so the published package and release tarball carry the two post-tag security fixes that v0.5.0's re-tagged run could not publish (409 — cannot publish over an existing version): the gitleaks test-fixture allowlist (`.gitleaks.toml`) and the linear slash-trim in the worker-patch protected-path check (CodeQL `js/polynomial-redos`, `workerResponse.ts`).
- Supersedes the unpublished `v0.5.1` tag (retired before its publish run); no functional changes beyond the fixes above. Bumped package to `0.5.2`.

## 0.5.0 - 2026-07-06

- S8 CCR hardening: failure-output exemption (≤8192-char failing output passes through verbatim), dead-marker/empty-output fail-open guards, miss-recovery (expired `<<ccr:HASH>>` retrieval names the originating tool), Foreman-side TTL default raised to 1800 s, vendored-fork SYNC.md with pinned upstream SHAs.
- Release engineering: push/PR CI (`ci.yml`), security workflow trio (npm audit / CodeQL / gitleaks) + dependabot, SECURITY.md with private-vulnerability-reporting route, publish smoke gate spawns the installed bin shim, SHA-pinned actions everywhere.
- Engineering ethos upstreamed: new `ethos` tool (24th) serving the bundled ethos doc with stack-profile sections; ethos content ported into the four protocol skills; project-level stack-profile override (`foreman-stack-profile.md`).
- Host contract: `generic` host id, single capability-set module with `unsupported_capabilities:` echo in `host_status`/`session_orient`, HOST-CONTRACT.md six-capability contract, `capability_check` closed status taxonomy (`ok|not_found|not_trusted|auth_expired|probe_timeout|error`) with versioned sentinel table, MCP `readOnlyHint`/`destructiveHint`/`title` annotations on all tools.
- Ledger enforcement pack: delegation cap (3 distinct rejected attempts, `user_override` escape), `inconclusive` verdict, attestation floor (5 words/32 chars), gate-staleness hash (`STALE` column + `stale_gates:` echo), atomic tmp-file writes with unique suffixes, D13 seat-minimum gate check, capability-class skill fragments (`FOREMAN_AGENT_CLASS`).
- S7 EXPERIMENTAL `invoke_worker` (25th tool): brief → OpenAI-compatible endpoint → shape-checked patch; `.foremanenv` config with `${ENV:NAME}` indirection + refuse-if-git-tracked; secret redaction on all durable writes (`[REDACTED:env:NAME]` markers); hash-chained append-only events sidecar (`Docs/.foreman-events.jsonl`); ledger post-write hook closes delegation chains; 17-stage failure taxonomy + recovery playbook in HOST-CONTRACT.md.
- S6 metrics: `read_ledger {query:"delegation_metrics"}` (survival-chain rates with explicit denominators, refund split, per-tier scorecard, drift warnings) and `ccr_stats` token-savings evidence folded into the ledger with a `ccr_savings:` footer; paired compression evidence run executed (advisory, never CI).
- `llms.txt` onboarding packet at repo root; README v0.5.0 funnel (host matrix, when-to-skip, migration note).
- Deliberated out of this release and banked for v0.6: the `invoke_worker` repair round (one release of one-shot failure-stage telemetry derives the repair trigger rules first), host-autonomy integration, and the full paired benchmark matrix (the promotion gate for worker/compression defaults).
- Bumped package to `0.5.0`.

## 0.4.0 - 2026-07-01

- Cost-tier telemetry and durable review records: delegations record `tier` + `route_reason` (appended to per-unit `delegations[]` history); `record_review` persists advisor findings to the ledger, retrievable via `read_ledger({ query: "reviews" })`.
- Relicensed from AGPL-3.0 to Apache-2.0 (2026-06-29).

## 0.3.0 - 2026-06-14

- New `preview_diagram` tool — live in-project Mermaid diagram workshop (23rd tool).

## 0.2.2 - 2026-06-13

- Successful `invoke_advisor` output (prose) is no longer eligible for lossy log compression — previously a review quoting >=3 error lines was misrouted to the log compressor and silently lost its recommendations. Success now passes through; only **failed** advisor diagnostics are compressed (and recoverable via `retrieve_original`).
- Trimmed the redundant advisor `STDERR` on clean success (CLI banner + echoed prompt + a verbatim duplicate of `STDOUT` + token count); the token count is preserved as a `tokens_used` meta line. `STDERR` is retained on failure or truncation.
- Fixed a meta-head line duplication in compressed `run_tests` output (the re-prepended `exit_code`/`passed`/`timed_out`/`truncated` block could repeat a line the compressor retained).
- `retrieve_original` and `invoke_advisor` tool descriptions now cue agents to retrieve the original when a compressed summary is insufficient.
- Bumped package, server, and tests to `0.2.2`.

## 0.2.1 - 2026-06-12

- Compressed `run_tests` / `invoke_advisor` output now retains the tool's leading meta block (`exit_code`, `passed`, `timed_out`, `truncated` / `cli`) — re-prepended onto the compressed digest. Previously the log compressor's error-extraction dropped these lines (pilot finding #1).
- Never applied to `smart_crusher` (JSON) output; skipped when the digest already contains the block.
- Bumped package, server, and tests to `0.2.1`.

## 0.2.0 - 2026-06-12

- Integrated `context-crush`: `run_tests` and `invoke_advisor` outputs ≥2048 bytes that detect as log/diff/json are compressed with reversible CCR storage; compressed output carries a `<<ccr:HASH>>` marker.
- New `retrieve_original` tool (22nd tool) exchanges a marker hash for the exact original output; unknown/expired hashes return a deterministic `ccr_missing_or_expired` error.
- Compression is **default ON** for the 0.2.0 pilot. Kill switch: `FOREMAN_COMPRESSION=0`. Per-tool allowlist: `FOREMAN_COMPRESSION_TOOLS` (default `run_tests,invoke_advisor`). CCR TTL: `CONTEXT_CRUSH_CCR_TTL_SECONDS` (default 300s).
- Prose/text outputs pass through unchanged; originals are always stored before lossy output escapes (fail-open invariant).
- `context-crush` is a bundled dependency (`bundleDependencies`) so packed tarballs are self-contained.
- Bumped package, server, and tests to `0.2.0`.

## 0.1.3 - 2026-06-09

- Documented the enforced `ip -> delegated -> pass` ledger sequence in the implementor protocol and the `write_ledger` tool description — previously the `delegated` step existed only in the enforcement code, so every first pass verdict hit `VERDICT BLOCKED` and the model learned the sequence from the error message.
- `update_phase_gate` with `g:'pass'` is now blocked unless every unit in the phase carries a pass verdict; empty phases cannot pass a gate.
- Pass verdicts on phases scoped `has_tests:false` or `has_build:false` now mechanically require a non-empty attestation `note` (previously prose-only).
- `set_phase_scope`'s test-file mismatch warning now surfaces in the tool result instead of stderr only.
- Read paths (`read_ledger`, `session_orient`, `write_progress`) report `ledger_corrupt` instead of silently treating a corrupt ledger as a fresh project, and never rename the corrupt file; writes recovering from corruption warn with the `.corrupt.<ts>` backup path.
- `read_ledger` single-unit and verdicts views now include `via` and `note`.
- Bumped package, server, and tests to `0.1.3`.

## 0.1.2 - 2026-06-08

- Added `verify_citations`: a deterministic tool that re-reads `[OBSERVED]`/`[IMPLEMENTED]` `file:line` evidence and reports CONFIRMED/DRIFTED/MISSING/UNANCHORED.
- Added a shared `citation-verification` protocol section (included by `spec_man` and `doc_man`); spec/doc completion now requires every claim-bearing citation to be CONFIRMED or explicitly downgraded.
- Fixed `capability_check` reporting an authenticated codex as `auth_status: expired` — codex health now uses `codex login status` instead of a full `codex exec` with a stale model under a 15s timeout.
- Codex advisor now runs `gpt-5.5` at `high` reasoning effort; Cursor advisor slug is `gpt-5.5-high`.
- Bumped package, server, and tests to `0.1.2`.

## 0.1.1 - 2026-06-08

- Updated MCP activation metadata so tool choice advertises the Foreman routing policy before a model opens the full skill body.
- `spec_man` metadata now calls out stale-plan detection, existing repo/spec re-evaluation, Atlas/Graphify code-surfacing, Plan Delta Ladder fields, and the rule that `D1` is not auto-promoted to `D0`.
- `lighttask` metadata now positions it as the small surgical default and says when to escalate into `spec_man`.
- `pitboss_implementor` metadata now calls out worker fan-out, retries, blocked work, recovery, multi-session resume, and optional LangGraph-style runtime-control triggers.
- Added regression coverage for activation-tool descriptions.
- Bumped package, server, tests, install docs, and release tarball to `0.1.1`.

## 0.1.0 - 2026-06-06

- First minor release for the lighttask/spec/doc protocol family.
- Promoted `lighttask`, `spec_man`, and `doc_man` tool heads.
- Added optional Graphify-backed Project Atlas guidance for `spec_man` grounding and `lighttask` stale-context re-evaluation.
- Added Plan Delta Ladder guidance for keeping raw findings, grouped deltas, candidate plans, and accepted current plans separate.
- Added dojo validation for Graphify/Atlas and cross-language legacy re-evaluation.

## 0.0.10 - 2026-06-06

- Added `lighttask`, `spec_man`, and `doc_man` skill activation tools.
- Introduced surgical-task gates for workspace classification, git context, spec freshness, grounding, bypass waivers, and adversarial review.
- Added grounded spec and documentation protocols.
- Added deterministic capability-check tests.

## Earlier Releases

Use the `changelog` MCP tool for the full historical table from `0.0.1` through `0.0.9`.
