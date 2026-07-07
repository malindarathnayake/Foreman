<!-- Capability-class assist fragments (S4-min). Rendered by skillLoader's
     {{class <list>: <id>}} markers per the DECLARED class (FOREMAN_AGENT_CLASS).
     Underscore prefix = not an MCP resource, never slash-discoverable.
     Keyed by capability class ONLY (compact / compact|capable) — never model IDs.
     Supercar rule: assists supplement canon; canonical protocol text is never
     truncated to make room for them. -->

<!-- section: worked-brief-exemplar -->
### Worked worker-brief exemplar (S7)

# Brief — Unit X
## Task — Add a `retries` field to the config loader.
## BEFORE (config.ts:12)
`export interface Config { timeoutMs: number }`
## AFTER
`export interface Config { timeoutMs: number; retries: number }`
## MUST DO
- Touch ONLY config.ts and config.test.ts.
- Default `retries` to 0 in loadConfig().
- Add one test: missing field -> 0.
## MUST NOT DO
- Do not rename existing fields. Do not edit other files. Do not reformat untouched lines.
## EXPECTED OUTPUT
- Unified diff for the two files, then one line: `TESTS: <pass|fail> <count>`.
<!-- /section -->

<!-- section: completion-report-exemplar -->
### Completion-report schema

Require exactly this shape from the worker:
FILES: <comma-separated paths touched>
TESTS: <command> -> <pass|fail> <n passed>/<n total>
DEVIATIONS: <none | one line each>
BLOCKED: <none | what and why>
<!-- /section -->

<!-- section: verdict-note-exemplar -->
### Verdict-note exemplar (set_verdict note)

"Independently validated: <suite> N/N re-run by pitboss; diff-audited <files>;
G1-G5 pass; G6 <applies + evidence | n/a + cited rows>; deviations recorded in <where>."
<!-- /section -->

<!-- section: fix-brief-exemplar -->
### Fix-brief exemplar (fresh worker, attempt N of 3)

## What Was Wrong — file.ts:42 returned [] instead of throwing on invalid input.
## What the Spec Says — "invalid input MUST throw CONFIG_INVALID" (quoted exactly).
## Fix — in file.ts:42 replace `return []` with `throw new Error("CONFIG_INVALID: ...")`.
## Leave Alone — parser.ts, every test file except config.test.ts.
## Previous Attempts — attempt 1 returned null (rejected: same class of silent failure).
<!-- /section -->

<!-- section: tool-loop-guard -->
### Tool-loop guard

If the same tool call fails twice with the same error, STOP calling it.
State the exact error, what you tried, and return to the caller.
Never retry a third time without changing something material.
A loop is a finding to report, not a wall to push through.
<!-- /section -->

<!-- section: output-format-guard -->
### Output-format guard

Never emit tool calls as text — if you intend to call a tool, CALL it.
Prose that looks like `{"tool": ...}` or XML tool syntax is a protocol error.
Final answers are plain text/diff per the brief's EXPECTED OUTPUT, nothing else.
<!-- /section -->

<!-- section: patch-hygiene-guard -->
### Patch-hygiene guard

When editing a line, copy the original line exactly, then change only the token you must.
Never retype surrounding code from memory; never reflow or reformat untouched lines.
One logical change per hunk; if a hunk will not apply, re-read the file — do not guess.
<!-- /section -->
