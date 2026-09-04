---
id: intro
title: What Foreman is
sidebar_label: What Foreman is
slug: /
description: An MCP server that gives Claude Code, Cursor, or Codex a spec-to-implementation procedure and a ledger that refuses skipped steps.
---

# What Foreman is

Foreman is an MCP server. It exposes 27 tools to Claude Code, Cursor, and Codex: six protocol tools that return a working procedure to the model, and the state, test, worker, and review tools that procedure tells the model to call. Project state lives in `Docs/.foreman-ledger.json` inside your repo. The server validates every write to that file and refuses the ones that skip a step.

## Who does what

| Actor | What it does |
|---|---|
| You | Answer design questions, approve the design summary, arbitrate deadlocks, override gates, commit |
| The host model, called the pit-boss in the procedures | Follows the protocol: plans, writes worker briefs, starts workers, inspects their output, runs tests, records verdicts, requests reviews |
| Workers | Subagents the host spawns to implement one unit from a brief. They see the brief only, never the spec or the ledger |
| Reviewers | Separate CLIs or endpoints that review a phase and return findings: Codex CLI, Gemini CLI, headless Claude, or a configured council |
| Foreman, the MCP server | Serves the procedures; validates and writes the ledger, progress, and journal files; runs allowlisted test commands; spawns reviewer CLIs; applies the refusals on [What Foreman enforces](./enforcement/what-foreman-enforces.md) |
| Your repo tooling | Compilers, tests, linters. Foreman runs them through `run_tests`. It does not replace them |

## A ten-line example

You, in Claude Code, in the repo:

```text
Use the Foreman MCP server. Call session_orient, then pitboss_implementor with the
context "Resume from Foreman state."
```

What the host does next, driven by the ledger:

```text
mcp__foreman__session_orient      -> action: implement_unit  resume_target: p2/u3
mcp__foreman__write_ledger        set_unit_status u3 { s: "ip" }
mcp__foreman__write_ledger        set_unit_status u3 { s: "delegated", brief, preflight }
Agent (worker subagent)           implements u3 from the brief, reports back
mcp__foreman__run_tests           the unit's test command
mcp__foreman__write_ledger        set_verdict u3 { v: "pass" }
```

The ledger now holds u3's brief, its delegation entry with the preflight attestation, and a verdict with a timestamp. The next session's `session_orient` starts at u4.

## What it is not

- **Not an IDE, an agent runtime, or a daemon.** It is a stdio process your host starts and stops.
- **Not a sandbox around the host.** Workers are the host's own subagents. Foreman cannot intercept their file or git operations. It catches damage after the fact: the procedure makes the host re-read every changed file and rerun tests before a verdict.
- **Not a proof of correctness.** The ledger proves the recorded sequence happened. It cannot prove the model read what it said it read.
- **Not CI.** Phase gates run in your session, before commit. Your CI still runs after.

## When to use it

Work that spans several units or sessions. Work where a wrong "done" is expensive. Work that another person, or another model, must be able to pick up mid-stream from a file rather than from a chat transcript.

## When to skip it

A one-file fix that finishes in one session. A throwaway prototype. A large mechanical rename. Every unit costs a brief, a worker run, a file inspection, a test run, and a verdict. Every phase adds a review round. `lighttask` is the low-ceremony path for one small change; for anything smaller than that, do not load Foreman at all.

Next: [Install](./getting-started/installation.md).
