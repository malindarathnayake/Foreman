// lib/foremanFiles.ts (v0.6.20): the single list of what Foreman writes on its own behalf.
// The repository guard excludes exactly this set; the writers import their names from it.
// The pure predicate and the fenced fingerprint are tested here; the guard's use of them
// against a real git repository is in repoGuard.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import {
  DEFAULT_PATHS, DEFAULT_SCOPE, EVENTS_FILE, FOREMAN_STATE_NAMES, JOURNAL_FILE, LEDGER_FILE, PROGRESS_MARKDOWN,
  PROGRESS_STATE_FILE, RECEIPTS_FILE, STATE_SIDE_SUFFIX, canonicalPath, eventsPathFor, fenceBlocksOf, fencedFingerprint,
  foremanFileScope, isForemanStateFile, receiptsPathFor, relativeScope, stripFences, type RelativeScope, HEARTBEAT_FILE, PREFLIGHT_FILE } from "../src/lib/foremanFiles.js"
import { receiptsPathFor as receiptsPathFromSeats, RECEIPTS_FILE as RECEIPTS_FROM_SEATS, appendReceipt } from "../src/lib/seatReceipts.js"
import { FENCE_END, FENCE_START, parseFencedBlock } from "../src/lib/progressFence.js"
import * as writeProgressTool from "../src/tools/writeProgress.js"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { readJournal } from "../src/lib/journal.js"
import { readProgress, writeProgress } from "../src/lib/progress.js"
import { takeSnapshot } from "../src/lib/repoGuard.js"

const rel = (state: string[] = [], fenced: string[] = []): RelativeScope => ({ state: new Set(state), fenced: new Set(fenced) })

/** What tools/writeProgress.ts writes for a file with no usable fence pair. */
function foremanAppend(existing: string, checklist = "- [ ] u1 — delegated\n"): string {
  return existing + (existing.endsWith("\n") ? "" : "\n") + "\n" + FENCE_START + "\n" + checklist + FENCE_END + "\n"
}
/** What tools/writeProgress.ts writes for a well-formed fence pair. */
function foremanSplice(existing: string, checklist = "- [x] u1 — pass\n"): string {
  const block = parseFencedBlock(existing)
  return existing.slice(0, block.startIdx + FENCE_START.length) + "\n" + checklist + existing.slice(block.endIdx)
}

describe("one list, imported by the writers", () => {
  it("the reserved names are the seven state files and nothing else", () => {
    expect([...FOREMAN_STATE_NAMES].sort()).toEqual([EVENTS_FILE, JOURNAL_FILE, LEDGER_FILE, PROGRESS_STATE_FILE, RECEIPTS_FILE, HEARTBEAT_FILE, PREFLIGHT_FILE].sort())
    expect(FOREMAN_STATE_NAMES.has(PROGRESS_MARKDOWN)).toBe(false)
  })

  it("server defaults are the pre-0.6.20 literals, byte for byte, on every platform", () => {
    expect(DEFAULT_PATHS).toEqual({
      ledgerPath: "Docs/.foreman-ledger.json",
      progressPath: "Docs/.foreman-progress.json",
      journalPath: "Docs/.foreman-journal.json",
      docsDir: "Docs",
    })
  })

  it("seatReceipts and writeProgress re-export from here rather than carrying a second copy", () => {
    expect(receiptsPathFromSeats).toBe(receiptsPathFor)
    expect(RECEIPTS_FROM_SEATS).toBe(RECEIPTS_FILE)
    expect(writeProgressTool.FENCE_START).toBe(FENCE_START)
    expect(writeProgressTool.FENCE_END).toBe(FENCE_END)
    expect(writeProgressTool.parseFencedBlock).toBe(parseFencedBlock)
  })

  it("the scope names the seven state files beside the ledger and PROGRESS.md in docsDir", () => {
    const scope = foremanFileScope(DEFAULT_PATHS)
    expect(scope.state.map((p) => path.basename(p)).sort()).toEqual([...FOREMAN_STATE_NAMES].sort())
    expect(scope.state).toContain(path.resolve(eventsPathFor(DEFAULT_PATHS.ledgerPath)))
    expect(scope.fenced).toEqual([path.resolve("Docs", "PROGRESS.md")])
    expect(DEFAULT_SCOPE).toEqual({ state: [], fenced: [] })
  })
})

describe("isForemanStateFile", () => {
  it("excuses the reserved names wherever they sit", () => {
    for (const name of FOREMAN_STATE_NAMES) {
      expect(isForemanStateFile(name)).toBe(true)
      expect(isForemanStateFile(`Docs/${name}`)).toBe(true)
      expect(isForemanStateFile(`deep\\nested\\${name}`)).toBe(true)
    }
  })

  it("excuses the side files of a reserved name and nothing that merely resembles one", () => {
    expect(isForemanStateFile("Docs/.foreman-ledger.json.corrupt.1725000000000")).toBe(true)
    expect(isForemanStateFile("Docs/.foreman-journal.json.1725000000000.deadbeef.tmp")).toBe(true)
    expect(isForemanStateFile("Docs/.foreman-progress.json.corrupt.1")).toBe(true)
    // A bare *.tmp is a worker file. The blanket rule that excused it is gone.
    expect(isForemanStateFile("scratch.tmp")).toBe(false)
    expect(isForemanStateFile("Docs/diagrams/x.svg.tmp")).toBe(false)
    // Wrong shape next to a reserved name: not a writer's side file.
    expect(isForemanStateFile("Docs/.foreman-ledger.json.bak")).toBe(false)
    expect(isForemanStateFile("Docs/.foreman-ledger.json.tmp")).toBe(false)
    expect(isForemanStateFile("Docs/.foreman-ledger.json.corrupt.x")).toBe(false)
    expect(isForemanStateFile("Docs/.foreman-ledger.json.1.deadbeef.tmp.orig")).toBe(false)
    expect(STATE_SIDE_SUFFIX.test(".corrupt.1725000000000")).toBe(true)
    expect(STATE_SIDE_SUFFIX.test(".tmp")).toBe(false)
  })

  it("excuses a custom-named state file and its side files by path, not by name", () => {
    const scope = rel(["state/ledger.json", "state/journal.json"])
    expect(isForemanStateFile("state/ledger.json", scope)).toBe(true)
    expect(isForemanStateFile("state/ledger.json.corrupt.1725000000000", scope)).toBe(true)
    expect(isForemanStateFile("state/journal.json.1725000000000.0badf00d.tmp", scope)).toBe(true)
    // The same basename elsewhere is a user file.
    expect(isForemanStateFile("other/ledger.json", scope)).toBe(false)
    expect(isForemanStateFile("ledger.json", scope)).toBe(false)
  })

  it("never excuses PROGRESS.md: that file is fenced, not excused", () => {
    expect(isForemanStateFile("Docs/PROGRESS.md", rel([], ["Docs/PROGRESS.md"]))).toBe(false)
    expect(isForemanStateFile("PROGRESS.md")).toBe(false)
  })
})

describe("fencedFingerprint", () => {
  it("hashes the whole trimmed content when there is no fence", () => {
    expect(fencedFingerprint("# Plan\n\nprose\n")).toBe(fencedFingerprint("# Plan\n\nprose"))
    expect(fencedFingerprint("# Plan\n\nprose\n")).not.toBe(fencedFingerprint("# Plan\n\nprose changed\n"))
    expect(fencedFingerprint("x")).toMatch(/^1:[0-9a-f]{16}$/)
  })

  it("Foreman's first write on a fenceless file compares equal", () => {
    const before = "# Plan\n\nprose without a trailing newline"
    expect(fencedFingerprint(foremanAppend(before))).toBe(fencedFingerprint(before))
  })

  it("a splice into a well-formed fence compares equal; an edit outside it does not", () => {
    const before = `preamble\n${FENCE_START}\nOLD\n${FENCE_END}\npostamble\n`
    expect(fencedFingerprint(foremanSplice(before))).toBe(fencedFingerprint(before))
    expect(fencedFingerprint(foremanSplice(before).replace("postamble", "planted"))).not.toBe(fencedFingerprint(before))
    expect(fencedFingerprint(before.replace("preamble", ""))).not.toBe(fencedFingerprint(before))
  })

  it("the fence interior is not part of the fingerprint", () => {
    const a = `p\n${FENCE_START}\n- [ ] u1\n${FENCE_END}\n`
    const b = `p\n${FENCE_START}\n- [x] u1 — pass\n${FENCE_END}\n`
    expect(fencedFingerprint(a)).toBe(fencedFingerprint(b))
  })

  it("T4b: the writer's malformed-marker append (lone START, lone END, inverted) compares equal", () => {
    const loneStart = `intro\n${FENCE_START}\nuser prose after a stray start\n`
    const loneEnd = `intro\n${FENCE_END}\nuser prose after a stray end\n`
    const inverted = `intro\n${FENCE_END}\nmiddle\n${FENCE_START}\ntail\n`
    for (const before of [loneStart, loneEnd, inverted]) {
      const after = foremanAppend(before)
      // The writer takes the malformed branch for all three (tools/writeProgress.ts).
      const block = parseFencedBlock(before)
      expect(block.hasStart && block.hasEnd && block.startIdx < block.endIdx).toBe(false)
      expect(fencedFingerprint(after)).toBe(fencedFingerprint(before))
      // A stray marker stays in the text, so removing it is still a change.
      expect(fencedFingerprint(after.replace(/intro\n<!--[^\n]*\n/, "intro\n"))).not.toBe(fencedFingerprint(before))
    }
  })

  it("a second fence is a change: the block count is carried in the fingerprint", () => {
    const before = `p\n${FENCE_START}\nx\n${FENCE_END}\n`
    const planted = before + `\n${FENCE_START}\nplanted content\n${FENCE_END}\n`
    expect(stripFences(before).blocks).toBe(1)
    expect(stripFences(planted).blocks).toBe(2)
    expect(stripFences("no fence").blocks).toBe(0)
    expect(fenceBlocksOf(fencedFingerprint(before))).toBe(1)
    expect(fenceBlocksOf(fencedFingerprint("no fence"))).toBe(1) // zero clamps to one: the first write is not a change
    expect(fenceBlocksOf(fencedFingerprint(planted))).toBe(2)
    expect(fencedFingerprint(planted)).not.toBe(fencedFingerprint(before))
  })
})

describe("relativeScope", () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-files-")) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it("keeps paths inside the root, drops paths outside it, tolerates a not-yet-existing tail", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-files-out-"))
    try {
      const scope = foremanFileScope({
        ledgerPath: path.join(dir, "Docs", ".foreman-ledger.json"),
        progressPath: path.join(outside, ".foreman-progress.json"),
        journalPath: path.join(dir, "Docs", ".foreman-journal.json"),
        docsDir: path.join(dir, "Docs"),
      })
      const r = await relativeScope(scope, dir)
      expect([...r.state].sort()).toEqual([
        "Docs/.foreman-events.jsonl", "Docs/.foreman-heartbeat.jsonl", "Docs/.foreman-journal.json", "Docs/.foreman-ledger.json", "Docs/.foreman-preflight.jsonl", "Docs/.foreman-seats.jsonl",
      ])
      expect([...r.fenced]).toEqual(["Docs/PROGRESS.md"])
      // The root itself, and a sibling directory with the root as a prefix, are outside.
      const sibling = foremanFileScope({ ledgerPath: dir + "-x/.foreman-ledger.json", progressPath: dir, journalPath: dir, docsDir: dir + "-x" })
      const rs = await relativeScope(sibling, dir)
      expect(rs.state.size).toBe(0)
      expect(rs.fenced.size).toBe(0)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("canonicalises through a link so a linked or short-named spelling is still inside the root", async () => {
    const link = dir + "-link"
    await fs.symlink(dir, link, process.platform === "win32" ? "junction" : "dir")
    try {
      expect(await canonicalPath(path.join(link, "Docs", "PROGRESS.md"))).toBe(await canonicalPath(path.join(dir, "Docs", "PROGRESS.md")))
      const scope = foremanFileScope({
        ledgerPath: path.join(link, "Docs", ".foreman-ledger.json"),
        progressPath: path.join(link, "Docs", ".foreman-progress.json"),
        journalPath: path.join(link, "Docs", ".foreman-journal.json"),
        docsDir: path.join(link, "Docs"),
      })
      const r = await relativeScope(scope, dir)
      expect(r.state.size).toBe(7)
      expect([...r.fenced]).toEqual(["Docs/PROGRESS.md"])
      // And the other way round: a link-spelled root against a real-spelled scope.
      const r2 = await relativeScope(foremanFileScope({
        ledgerPath: path.join(dir, "Docs", ".foreman-ledger.json"),
        progressPath: path.join(dir, "Docs", ".foreman-progress.json"),
        journalPath: path.join(dir, "Docs", ".foreman-journal.json"),
        docsDir: path.join(dir, "Docs"),
      }), link)
      expect(r2.state.size).toBe(7)
    } finally {
      await fs.rm(link, { recursive: true, force: true })
    }
  })
})

describe("T9: the writers and the guard agree", () => {
  let repo: string
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-files-repo-"))
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    git("config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(repo, "Docs"))
    await fs.writeFile(path.join(repo, "Docs", "PROGRESS.md"), "# Plan\n")
    git("add", ".")
    git("commit", "-q", "-m", "init")
  })
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }) })

  it("every file the real writers produce, including their side files, is excluded from the snapshot", async () => {
    const paths = {
      ledgerPath: path.join(repo, "Docs", LEDGER_FILE),
      progressPath: path.join(repo, "Docs", PROGRESS_STATE_FILE),
      journalPath: path.join(repo, "Docs", JOURNAL_FILE),
      docsDir: path.join(repo, "Docs"),
    }
    // Corrupt files first: each reader renames them to <file>.corrupt.<ms> before writing fresh state.
    for (const p of [paths.ledgerPath, paths.progressPath, paths.journalPath]) await fs.writeFile(p, "{not json")
    await readLedger(paths.ledgerPath)
    await readProgress(paths.progressPath)
    await readJournal(paths.journalPath)
    await writeLedger(paths.ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "pending" } })
    await writeProgress(paths.progressPath, { operation: "start_phase", data: { phase: "p1", name: "Phase" } })
    await appendReceipt(receiptsPathFor(paths.ledgerPath), {
      cli: "codex", provider: "openai", model_served: "m", exit_code: 0, failure_reason: null, prompt_sha256: "a".repeat(64), bytes_in: 1, bytes_out: 1,
    })
    await fs.writeFile(eventsPathFor(paths.ledgerPath), "")
    // The atomic-write tmp sibling, in the exact shape lib/atomicWrite.ts produces.
    await fs.writeFile(`${paths.journalPath}.${Date.now()}.0badf00d.tmp`, "{}")
    // Foreman's own progress write, through the tool, with a fence.
    await writeProgressTool.handleWriteProgress(paths.progressPath, { operation: "start_phase", data: { phase: "p1", name: "Phase" } }, paths.docsDir, paths.ledgerPath)

    const dirty = git("status", "--porcelain", "-uall").split("\n").filter((l) => l.trim())
    expect(dirty.filter((l) => l.includes(".corrupt.")).length).toBe(3)
    expect(dirty.length).toBeGreaterThanOrEqual(9)

    const out = await takeSnapshot(repo, [], [], undefined, foremanFileScope(paths))
    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`)
    // Only PROGRESS.md survives, as a fenced entry whose fingerprint ignores the block Foreman wrote.
    expect(out.snapshot.entries.map((e) => e.path)).toEqual(["Docs/PROGRESS.md"])
    expect(out.snapshot.entries[0].fenced).toBe(true)
    expect(out.snapshot.entries[0].fwt).toBe(fencedFingerprint("# Plan\n"))
    expect(out.foreman_files).toBe(8)
  })
})
