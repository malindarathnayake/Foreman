#!/usr/bin/env node
// Node stand-in for the (later, phase-4) Python aider harness. Consumed ONLY by
// tests/aiderWorker.test.ts via FOREMAN_AIDER_PYTHON="node" + FOREMAN_AIDER_HARNESS
// pointing at this file's absolute path — no python, no network. Node built-ins only.
//
// Reads the harness request as JSON from stdin, behaves according to FIXTURE_MODE
// (env var, default "edit"), and prints a single line of JSON metadata to stdout that
// mimics the real harness's result envelope.
//
// Modes:
//   edit       - appends a line to every fname in request.fnames (a real worktree
//                edit) and reports them all as aider_edited_files.
//   noedit     - makes no edits at all (-> empty git diff -> WORKER_GHOST upstream).
//   redaction  - writes a line containing a `[REDACTED:env:X]` marker into the first
//                fname (-> redaction-marker rejection upstream).
//   crash      - exits non-zero with a message on stderr (simulated harness crash).
//   badjson    - prints non-JSON to stdout and exits 0 (-> MODEL_SCHEMA_FAIL upstream).
//   llmerror   - makes no edits; exits 0 with a well-formed result envelope but
//                error_kind:"aider_llm_error" (-> WORKER_AIDER_LLM_ERROR upstream),
//                simulating a provider-side LLM error surfaced through the harness's
//                normal (non-crashing) exit path.

import fs from "node:fs"
import path from "node:path"

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })
}

async function main() {
  const raw = await readStdin()

  // Probe mode: `<node> fixture.mjs --probe`. Side-effect-free capability check.
  // FIXTURE_AIDER_AVAILABLE="0" simulates aider not importable (sentinel exit 20).
  if (process.argv.includes("--probe")) {
    if (process.env.FIXTURE_AIDER_AVAILABLE === "0") {
      process.stdout.write(JSON.stringify({ ok: false, error_kind: "binary_not_found", missing: "aider", probe: true }))
      process.exit(20)
    }
    process.stdout.write(JSON.stringify({ ok: true, probe: true }))
    process.exit(0)
  }

  let request
  try {
    request = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`fixture: failed to parse stdin request: ${err.message}\n`)
    process.exit(2)
  }

  const mode = process.env.FIXTURE_MODE ?? "edit"

  if (mode === "crash") {
    // Deliberately echoes request.api_key into stderr so the consumer's scrub-then-bound
    // discipline [CWE-532] can be exercised by a real (fixture) secret value, not a no-op.
    const key = typeof request.api_key === "string" ? request.api_key : ""
    process.stderr.write(`fixture: simulated aider harness crash; leaked context: api_key=${key}\n`)
    process.exit(3)
  }

  if (mode === "badjson") {
    process.stdout.write("not json")
    process.exit(0)
  }

  const fnames = Array.isArray(request.fnames) ? request.fnames : []
  const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd()

  let editedFiles = []

  if (mode === "edit") {
    for (const fname of fnames) {
      const filePath = path.join(cwd, fname)
      fs.appendFileSync(filePath, "aider fixture edit line\n", "utf-8")
    }
    editedFiles = fnames
  } else if (mode === "redaction") {
    if (fnames.length > 0) {
      const filePath = path.join(cwd, fnames[0])
      fs.appendFileSync(filePath, "[REDACTED:env:X]\n", "utf-8")
      editedFiles = [fnames[0]]
    }
  } else if (mode === "envprobe") {
    // Writes whether a planted secret-named env var reached this child. The consumer
    // (aiderWorker) filters the child env, so the child must see "ABSENT".
    if (fnames.length > 0) {
      const seen = process.env.FOREMAN_PROBE_SECRET ?? "ABSENT"
      const filePath = path.join(cwd, fnames[0])
      fs.appendFileSync(filePath, `ENVCHECK=${seen}\n`, "utf-8")
      editedFiles = [fnames[0]]
    }
  }
  // "noedit"/"llmerror" mode (or any other unrecognized mode): make no edits at all.

  const errorKind = mode === "llmerror" ? "aider_llm_error" : "none"
  const errorDetail = mode === "llmerror" ? "litellm 502 from endpoint (fixture)" : ""

  const result = {
    ok: true,
    aider_edited_files: editedFiles,
    num_malformed_responses: 0,
    num_reflections: 1,
    num_exhausted_context_windows: 0,
    total_tokens_sent: 100,
    total_tokens_received: 20,
    total_cost: 0.01,
    reflections_capped: false,
    error_kind: errorKind,
    error_detail: errorDetail,
  }
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

main()
