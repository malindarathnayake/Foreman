# v0.0.6 Design Summary — `run_advisor` Tool + Arch Council Integration

## Problem

Foreman's deliberation protocol (design-partner, spec-generator, implementor) currently tells the LLM to manually run Codex/Gemini via Bash. This breaks because:

1. **Shell escaping** — multi-line prompts with backticks, `$`, quotes fail in Bash
2. **No output bounds** — verbose CLI output blows the LLM's context window
3. **Fragile invocation** — each skill hardcodes CLI flags, heredoc patterns, temp file workarounds
4. **No fallback** — if both CLIs are missing, deliberation silently degrades to "ask user"
5. **No auth detection** — Gemini headless requires `GEMINI_API_KEY` but nothing checks this at startup

## Solution

New MCP tool `run_advisor` that wraps Codex/Gemini CLI invocations (and falls back to Opus/Sonnet agents) with bounded output, structured briefs, and startup probing.

## Architecture

```
Startup:
  probe codex (FOREMAN_PROBE_OK) ─┐
  probe gemini (FOREMAN_PROBE_OK) ─┤── parallel, 30s timeout each
  check .env for GEMINI_API_KEY ──┘
  → register run_advisor with live CLIs only

Runtime:
  Caller builds brief (.toon file) → writes to .foreman/briefs/
  Calls run_advisor({ cli, brief_file, output_file })
  Tool handles transport:
    Codex:  short CLI arg → reads brief from disk → reads source files → stdout
    Gemini: embeds brief content in -p flag → stdout
    Opus:   Agent tool with brief + embedded files → response
  Tool captures output → writes to output_file
  Caller (pitboss/moderator) reads output_file
```

## POC Results (2026-04-10)

All patterns tested with real workloads (15K char prompts, 5 source files, security review):

| Pattern | Result | Time |
|---|---|---|
| Codex: short prompt as CLI arg + `read-only` + stdout | **works** | 12s |
| Codex: brief file in repo + `read-only` + stdout | **works** (5 findings, TOON format) | ~120s |
| Codex: `workspace-write` file output | **too slow** (30min+, approval overhead) | killed |
| Codex: large prompt as CLI arg | **fails** (timeout, shell arg limits) | 300s timeout |
| Codex: pure stdin pipe + `-` flag (shell) | **works** | ~120s |
| Codex: stdin via spawn() stdin.write + `-` | **fails** (timeout) | 300s timeout |
| Gemini: 15K prompt via `-p` spawn arg | **works** | 110s |
| Gemini: short prompt via `-p` spawn arg | **works** | 7.5s |
| Startup probe: both CLIs parallel | **works** | 6.5s parallel |

### Key Findings

1. **Codex cannot receive large prompts as CLI args or via Node.js spawn() stdin.** Must use a brief file that Codex reads from disk, with a short CLI arg instruction.
2. **Codex `workspace-write` is unusably slow** — every file op is an internal approval step. Use `read-only` + stdout capture.
3. **Gemini `-p` flag handles 15K+ prompts fine** via spawn() args (no shell needed, no temp file needed).
4. **Gemini headless requires `GEMINI_API_KEY` env var** for reliable operation. `google-login` auth breaks on token expiry.
5. **Startup probe with `FOREMAN_PROBE_OK` marker** reliably detects live CLIs in ~6s parallel.

## Tool API

```typescript
run_advisor({
  cli: "codex" | "gemini" | "opus" | "sonnet",  // restricted to live CLIs at registration
  brief_file: string,     // path to .toon brief in repo (Codex reads from disk, Gemini/Opus get content embedded)
  output_file: string,    // where to write results (tool writes after capturing stdout/response)
  timeout_ms?: number,    // default 300000 (5 min)
  max_output_chars?: number,  // default 16000
})
```

### Transport per CLI

| | Brief delivery | File access | Output capture | Sandbox |
|---|---|---|---|---|
| **Codex** | Short CLI arg: "Read {brief_file}" | Reads files from disk natively | stdout → tool writes to output_file | `read-only` |
| **Gemini** | `-p` flag with brief content + embedded file excerpts | Cannot read disk | stdout → tool writes to output_file | `--approval-mode plan` |
| **Opus/Sonnet** | Agent tool prompt with brief content + embedded file excerpts | Via Read tool | Agent response → tool writes to output_file | Agent sandbox |

### Brief File Format (.toon)

```
role: <reviewer type>
task: <what to do>
mode: explore-freely | check-list

ENTRY POINTS:
- <file path> (<what to look for>)
- <file path> (<what to look for>)

FOCUS AREAS:
1. <specific question>
2. <specific question>

INSTRUCTIONS:
- Read any file you need. Follow imports, trace call chains.
- For each finding: trace source→sink with file:line refs.

OUTPUT FORMAT:
finding: <N>
type: <vulnerability type>
severity: critical | high | medium | low
source: <file:line>
sink: <file:line>
path: <source> → <intermediate:line> → <sink>
fix: <one-line fix>
note: <why this matters>
```

### Startup Probe Flow

```
1. Read .env from project root (if exists) → load GEMINI_API_KEY into process.env
2. Probe codex + gemini in parallel (30s timeout):
     spawn("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-5.4",
       "Reply with exactly: FOREMAN_PROBE_OK"])
     spawn("gemini", ["-p", "Reply with exactly: FOREMAN_PROBE_OK",
       "-m", "arch-review", "--approval-mode", "plan", "--output-format", "text"])
3. Check stdout contains "FOREMAN_PROBE_OK" → mark live
4. If gemini fails and no GEMINI_API_KEY:
     Log: "Gemini requires GEMINI_API_KEY for headless mode. Add to .env file."
5. Register run_advisor with enum restricted to live CLIs + always include opus/sonnet fallback
6. Cache probe results — never re-probe during process lifetime
```

### 3-Tier Fallback

| Tier | Condition | Advisor A | Advisor B | Moderator |
|---|---|---|---|---|
| 1 | Both CLIs live | Codex | Gemini | Opus (caller) |
| 2 | One CLI live | Live CLI | Opus Agent | Opus (caller) |
| 3 | No CLIs | Opus Agent | Sonnet Agent (adversarial) | Opus (caller) |

## Deliberation Architecture

```
Caller builds brief → writes .foreman/briefs/{task}.toon

run_advisor(codex, brief) ──→ findings-a.toon
run_advisor(gemini, brief) ──→ findings-b.toon
                                    │
                    Opus moderator reads both
                    ├─ Where they agree → high confidence
                    ├─ Where they disagree → investigate
                    └─ Where one found something other missed → validate
                                    │
                    Present synthesized findings to user
```

Advisors NEVER see each other's output. Independent analysis, then moderator synthesis.

## Skill Protocol Changes

All three skill protocols (design-partner.md, spec-generator.md, implementor.md) have a "Deliberation Protocol" section that manually invokes Codex/Gemini via Bash. These get replaced with:

```
### Deliberation Protocol
1. Build brief: write .foreman/briefs/{phase}-review.toon
2. mcp__foreman__run_advisor({ cli: "codex", brief_file: ".foreman/briefs/{phase}-review.toon", output_file: ".foreman/output/advisor-a.toon" })
3. mcp__foreman__run_advisor({ cli: "gemini", brief_file: ".foreman/briefs/{phase}-review.toon", output_file: ".foreman/output/advisor-b.toon" })
4. Read both output files
5. Moderate: compare, challenge disagreements, synthesize
6. mcp__foreman__normalize_review — parse findings into structured format
```

The `capability_check` tool becomes redundant — `run_advisor` handles availability internally via the startup probe.

## .env and .gitignore

Foreman reads `.env` at startup for:
- `GEMINI_API_KEY` — required for headless Gemini
- `FOREMAN_TEST_ALLOWLIST` — custom test runner prefixes for `run_tests` (from v0.0.5)

`.env` must be in `.gitignore`. If not already present, Foreman logs a warning at startup.

## Scope Boundaries

### In scope
- `run_advisor` MCP tool with 3-tier fallback
- Startup probe for Codex/Gemini liveness
- `.env` loading for `GEMINI_API_KEY`
- Brief file format (.toon)
- Skill protocol updates (replace manual Bash invocations with tool calls)
- `.foreman/` directory for briefs and output (ephemeral, gitignored)

### Out of scope
- Custom model selection (hardcoded to gpt-5.4 and arch-review alias)
- Gemini settings.json auto-configuration (user sets up `arch-review` alias manually)
- Streaming output during advisor execution
- `capability_check` deprecation (keep for backward compat, mark as legacy)
- Multi-round cross-examination within `run_advisor` (caller orchestrates rounds)

## Open Questions

1. Should `run_advisor` support a `review` mode that uses `codex exec review --uncommitted` for git-aware code review?
2. Should the brief file format support embedding file excerpts inline (for Gemini), or should the tool always handle that transparently?
3. Should `.foreman/` be created automatically on first `run_advisor` call, or require explicit setup?
4. Should the probe run on every server start, or cache to disk with a TTL?

## Dependencies

- Gemini CLI must have `arch-review` custom alias configured in `~/.gemini/settings.json`
- Codex CLI must be authenticated (`codex login`)

## Gating Clause — v0.0.5 Must Be Complete

**This version MUST NOT begin implementation until v0.0.5 is fully shipped.**

Before starting v0.0.6 spec generation, the spec generator MUST verify:

```
1. mcp__foreman__read_ledger({ query: "phase_gates" })
   → All v5-phase-1, v5-phase-2, v5-phase-3 gates must show g: "pass"

2. mcp__foreman__read_progress()
   → All v0.0.5 units must show status: "complete"

3. package.json version must be "0.0.5"

4. npm test must pass (all tests green)
```

If any check fails: STOP. Tell user which v0.0.5 items are incomplete. Do not proceed.

v0.0.6 depends on v0.0.5 for:
- `run_tests` tool (Phase 1-2) — `run_advisor` follows the same bounded-output pattern
- Security hardening (Phase 3) — input caps, rejection array cap, generic errors, CLI path resolution
- The `externalCli` buffer cap — `run_advisor` uses the same truncation pattern
