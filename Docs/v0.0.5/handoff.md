# v0.0.5 Handoff — Bounded Test Output + Security Hardening

## Project Overview

Adds output truncation to Foreman's test execution and external CLI paths, plus 6 security hardening items from the Purple Team pentest triage. Three phases: core infrastructure (buffer caps), integration (tool registration + protocol), security hardening (input caps, allowlist, path resolution). See [spec.md](spec.md) for full details.

## Before Starting

1. Read `Docs/v0.0.5/spec.md`
2. Read this file
3. `mcp__foreman__read_progress` — check current position
4. `mcp__foreman__read_ledger({ query: "full" })` — check verdicts

## Rules

- No scope additions — only the files listed per unit
- Run the test command after every unit
- Do not add JSON reporter parsing or structured output extraction
- Do not modify existing tool registrations when adding the new one
- `runTests.ts` must NOT import from `externalCli.ts` — duplicate the spawn pattern
- `runTests.ts` MUST validate runner against allowlist BEFORE spawning — never spawn first
- `runTests.ts` MUST NOT use `sh -c` or `shell: true` — spawn runner directly with args array
- All `.max()` constraints go in `types.ts`, not in individual tool handlers
- `brief` field gets `.max(50000)`, all other strings get `.max(10000)`

## Implementation Order

### Phase 1: Core Infrastructure

**Unit 1a — externalCli buffer cap**
- File: `foreman-mcp/src/lib/externalCli.ts`
- Add `export const MAX_OUTPUT = 16000`
- Add `truncated: boolean` to `ExternalCliResult` interface
- In both `stdout` and `stderr` `data` event handlers, after `+= chunk.toString()`, add truncation check: if buffer exceeds MAX_OUTPUT, slice to `buffer.slice(-MAX_OUTPUT)` and prepend `"...(truncated)\n"`. Track whether either buffer was truncated.
- Set `truncated` in the resolve object
- Pitfall: The truncation marker itself adds chars — slice to `MAX_OUTPUT` then prepend marker, total will be slightly over. This is acceptable.
- Test: `cd foreman-mcp && npx vitest run tests/externalCli.test.ts`

**Unit 1b — runTests tool handler**
- File: `foreman-mcp/src/tools/runTests.ts` (CREATE)
- **SECURITY: Validate `runner` against `DEFAULT_ALLOWED_RUNNERS` before spawning.** Export the allowlist array. Read `FOREMAN_TEST_ALLOWLIST` env var (comma-separated binary names) to extend. If runner not allowed, return TOON error string without spawning.
- **NO SHELL.** Use `spawn(runner, args)` — NOT `spawn("sh", ["-c", ...])`. Shell metacharacters in args have no effect.
- Follow the same timeout/SIGTERM/SIGKILL pattern from `externalCli.ts` but:
  - Use `maxOutputChars` parameter (default 8000) instead of hardcoded constant
  - **Truncate ONCE after process exits** — do not slice on every `data` event (O(N^2) for large output). Collect full buffer, then truncate at the end.
  - Return TOON format string
- Export function signature: `runTests(runner: string, args: string[], timeoutMs?: number, maxOutputChars?: number): Promise<string>`
- Output format:
  ```
  exit_code: <number>
  passed: <true|false>
  timed_out: <true|false>
  truncated: <true|false>

  STDOUT
  <stdout content>

  STDERR
  <stderr content>
  ```
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`
- The test file does not exist yet — worker creates it alongside the implementation

**Phase 1 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 2: Integration & Protocol

**Unit 2a — Register tool + version bump**
- Files: `server.ts`, `package.json`, `changelog.ts`
- Import: `import { runTests } from "./tools/runTests.js"`
- Register after `normalize_review` tool block:
  ```typescript
  server.registerTool(
    "run_tests",
    {
      description: "Runs a test command with bounded output. Runner must be in allowlist (npm, npx, pytest, go, cargo, dotnet, make). Use instead of Bash for test execution.",
      inputSchema: {
        runner: z.string().min(1),
        args: z.array(z.string()).default([]),
        timeout_ms: z.number().max(600000).optional(),
        max_output_chars: z.number().max(50000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await runTests(args.runner, args.args, args.timeout_ms, args.max_output_chars)
      return { content: [{ type: "text" as const, text }] }
    }
  )
  ```
- Version bumps: `package.json` version field `"0.0.4"` → `"0.0.5"`, `server.ts` McpServer constructor `"0.0.4"` → `"0.0.5"`
- Changelog: Add entry at index 0 of CHANGELOG array: `{ version: "0.0.5", date: "2026-04-09", description: "run_tests tool — bounded test output for pitboss validation; externalCli buffer cap at 16K chars" }`
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`
- Pitfall: `bundleStatus` test checks for `"bundle_version: 0.0.4"` — update assertion to `"0.0.5"`

**Unit 2b — Update implementor.md protocol**
- File: `foreman-mcp/src/skills/implementor.md`
- Change 1 — frontmatter line 3: `version: 0.0.4` → `version: 0.0.5`
- Change 2 — line 111: replace `2. **Re-run tests** — execute the test command yourself; do not accept worker's "tests pass" claim` with `2. **Re-run tests** — call mcp__foreman__run_tests with the unit's test command; read exit_code for pass/fail, STDERR tail for failure context. Do not run tests via Bash — raw output can overflow context.`
- Change 3 — after line 193 ("Run the complete test suite — not just this phase's tests."), append: `Run via mcp__foreman__run_tests, not Bash.`
- Test: `cd foreman-mcp && npx vitest run tests/skillLoader.test.ts`
- DO NOT change gates G1-G5, fix protocol, checkpoint deliberation flow, or any other section

**Phase 2 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 3: Security Hardening

From pentest triage (see `Docs/.triage-ledger.yaml`).

**Unit 3a — Tiered input length caps on write schemas**
- File: `foreman-mcp/src/types.ts`
- **Tiered caps:** `.max(50000)` for `brief` (trusted, contains code excerpts). `.max(10000)` for all other string fields.
- This is a one-line-per-field change — just chain `.max(N)` after each `z.string()`
- Test: `cd foreman-mcp && npx vitest run tests/writeTools.test.ts`
- Pitfall: existing tests may send strings that pass validation. No test currently sends >10000 char strings, so no breakage expected.
- NOTE: This mitigates exhaustion (EXH-002) but does NOT fully fix stored prompt injection (INJ-004). Strings under the limit still flow unescaped to LLM context. Full fix (read-path escaping) deferred to v0.0.6.

**Unit 3b — Rejection array cap + generic skill loader error**
- Files: `foreman-mcp/src/lib/ledger.ts`, `foreman-mcp/src/lib/skillLoader.ts`
- ledger.ts: After `rej.push(...)`, add `if (unit.rej.length > 20) unit.rej = unit.rej.slice(-20)`
- skillLoader.ts: Replace the 3-path error with generic message. Log full paths to stderr with `console.error`.
- Test: `cd foreman-mcp && npx vitest run tests/ledger.test.ts tests/skillLoader.test.ts`
- Pitfall: `skillLoader.test.ts` or `integration.test.ts` may assert on the old error message format — update those assertions.

**Unit 3c — Absolute path resolution for external CLIs**
- File: `foreman-mcp/src/tools/capabilityCheck.ts`
- Resolve bare `"codex"`/`"gemini"` to absolute path via `which` (using `runExternalCli("which", [cli], 3000)`)
- Cache in module-level `Map<string, string>` — resolve once per process
- If `which` fails → return `available: false` immediately
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`

**Unit 3d — Update changelog description**
- File: `foreman-mcp/src/tools/changelog.ts`
- Update v0.0.5 entry to mention security hardening items
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`

**Phase 3 Checkpoint:** `cd foreman-mcp && npx vitest run`

## Testing Strategy

Archetype: Unit tests with real child_process spawns. See [testing-harness.md](testing-harness.md).

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cd foreman-mcp && npx vitest run` | Full test suite |
| `cd foreman-mcp && npx vitest run tests/externalCli.test.ts` | externalCli tests only |
| `cd foreman-mcp && npx vitest run tests/runTests.test.ts` | runTests tests only |
| `cd foreman-mcp && npx vitest run tests/tools.test.ts` | Tool integration tests |
| `cd foreman-mcp && npm run build` | TypeScript compile |

| Error | Recovery |
|-------|----------|
| Type error in runTests.ts | Check ExternalCliResult interface matches — truncated field added in 1a |
| bundleStatus test fails | Update version assertion from 0.0.4 to 0.0.5 |
| skillLoader test fails | Check markdown frontmatter format is preserved |

## Start

**First session:** Begin at Phase 1, Unit 1a. Read the spec, read the existing `externalCli.ts`, implement the buffer cap.

**Resuming:** `mcp__foreman__read_progress` → find first non-complete unit → pick up there.
