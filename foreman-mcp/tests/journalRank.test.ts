import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { declareModel, initSession, readJournal } from "../src/lib/journal.js"
import type { WriteJournalInput } from "../src/types.js"

const init = (model?: string, effort?: string): WriteJournalInput => ({
  operation: "init_session", data: {
    target_version: "test", branch: "test", phase: "p1", units: [],
    env: { agent: "not-a-model", worker: "worker", codex: null, gemini: null, model, effort },
  },
})

describe("journal model declarations and active MCP policy", () => {
  let dir: string
  const connections: Array<{ server: McpServer; client: Client }> = []
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-rank-")) })
  afterEach(async () => {
    for (const { client, server } of connections.splice(0)) { await client.close(); await server.close() }
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function setup(host: "claude-code" | "cursor" | "codex" | "generic" = "codex") {
    const server = await createServer({ host, docsDir: dir, journalPath: path.join(dir, "journal.json"), ledgerPath: path.join(dir, "ledger.json"), progressPath: path.join(dir, "progress.json") })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "rank-test", version: "1" })
    await client.connect(ct)
    connections.push({ server, client })
    return client
  }
  async function call(client: Client, name: string, args: object = {}) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    return { text: (result.content as Array<{ text: string }>)[0].text, error: result.isError }
  }

  it("persists computed declaration, preserves class and bounds replacement history", async () => {
    const file = path.join(dir, "journal.json")
    const input = init("Astra", "high")
    if (input.operation !== "init_session") throw new Error("fixture")
    input.data.env.agent_class = "compact"
    const journal = await initSession(file, input)
    expect(journal.sessions[0].env).toMatchObject({ agent_class: "compact", model_rank: { weight: 3, session_id: "s1" } })
    for (let i = 0; i < 22; i++) await declareModel(file, { operation: "declare_model", data: { model: "Opus" } }, "s1")
    const saved = (await readJournal(file)).sessions[0]
    expect(saved.model_declarations).toHaveLength(20)
    expect(saved.env?.model_rank?.weight).toBe(2)
    await expect(declareModel(file, { operation: "declare_model", data: {} }, "wrong")).rejects.toThrow("current active session")
  })

  it.each(["claude-code", "cursor", "codex", "generic"] as const)("exposes one active policy across all read paths on %s", async host => {
    const client = await setup(host)
    expect((await call(client, "host_status")).text).toContain("model_weight: 0")
    const result = await call(client, "write_journal", init("Astra", "high"))
    expect(JSON.parse(result.text).model_rank.weight).toBe(3)
    const before = await fs.readFile(path.join(dir, "journal.json"), "utf8")
    for (const tool of ["host_status", "session_orient", "read_progress"]) {
      const output = await call(client, tool)
      expect(output.text).toContain("model_weight: 3")
      expect(output.text).toContain("focused_validation")
    }
    expect(await fs.readFile(path.join(dir, "journal.json"), "utf8")).toBe(before)
    const lowered = await call(client, "write_journal", { operation: "declare_model", data: { model: "Sol", weight: 3, permissions: { delta_review: true } } })
    expect(JSON.parse(lowered.text).model_rank.weight).toBe(0)
    expect((await call(client, "host_status")).text).toContain("workflow_permissions: none")
  })

  it("does not inherit rank from journal after restart, or infer rank from agent class", async () => {
    const first = await setup()
    await call(first, "write_journal", init("Fable 5.1"))
    const next = await setup("cursor")
    expect((await call(next, "host_status")).text).toContain("model_weight: 0")
    expect((await call(next, "write_journal", { operation: "declare_model", data: { model: "Astra", effort: "high" } })).error).toBe(true)
    const input = init()
    if (input.operation !== "init_session") throw new Error("fixture")
    input.data.env.agent = "Astra"
    input.data.env.agent_class = "frontier"
    expect(JSON.parse((await call(next, "write_journal", input)).text).model_rank.weight).toBe(0)
  })

  it("rejected declarations leave the current policy intact; ending a session resets it", async () => {
    const client = await setup()
    await call(client, "write_journal", init("Astra", "high"))
    expect((await call(client, "write_journal", { operation: "declare_model", data: { model: 42 } })).error).toBe(true)
    expect((await call(client, "host_status")).text).toContain("model_weight: 3")
    await call(client, "write_journal", { operation: "end_session", data: { dur_min: 1, ctx_used_pct: 5, summary: { units_ok: 0, units_rej: 0, w_spawned: 0, w_wasted: 0, tok_wasted: 0, delay_min: 0, blockers: [], friction: 0 } } })
    expect((await call(client, "host_status")).text).toContain("model_weight: 0")
    expect((await call(client, "write_journal", { operation: "declare_model", data: { model: "Fable 5.1" } })).error).toBe(true)
  })

  it("threads the declared rank into a guarded MCP worker correction and honors a downgrade", async () => {
    const repo = path.join(dir, "repo")
    await fs.mkdir(repo)
    const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: repo, windowsHide: true })
    await git("init", "-q")
    await git("config", "core.autocrlf", "false")
    await fs.writeFile(path.join(repo, "sample.txt"), "initial\n")
    await git("add", "sample.txt")
    await git("-c", "user.name=Rank Test", "-c", "user.email=rank@example.invalid", "commit", "-qm", "fixture")
    const client = await setup()
    await call(client, "write_journal", init("Astra", "high"))
    const preflight = { symbols_grepped: 1, self_consistent: true }
    const ledger = (operation: string, data: object) => call(client, "write_ledger", { operation, phase: "p1", unit_id: "u1", data })
    const guard = (operation: "snapshot" | "compare") => call(client, "repo_guard", {
      operation, phase: "p1", unit_id: "u1", project_dir: repo, files: ["sample.txt"],
      ...(operation === "snapshot" ? { allowed_files: ["sample.txt"] } : {}),
    })
    expect((await ledger("set_unit_status", { s: "delegated", brief: "Update the scoped sample text with the agreed correction.", preflight })).error).toBeUndefined()
    expect((await guard("snapshot")).text).toContain("status: recorded")
    await fs.writeFile(path.join(repo, "sample.txt"), "worker implementation\n")
    expect((await guard("compare")).text).toContain("status: ok")
    expect((await ledger("set_verdict", { v: "pass", via: "worker", worker_id: "native-worker-1", note: "Verified sample text against the expected output." })).error).toBeUndefined()
    const corrected = await ledger("set_unit_status", {
      s: "delegated", brief: "Correct sample text while preserving the agreed scope.", preflight,
      worker_id: "native-worker-1", correction: { kind: "bounded", from_attempt: 1, files: ["sample.txt"] },
    })
    expect(corrected.error, corrected.text).toBeUndefined()
    expect(corrected.text).toContain("Focused intermediate validation")
    expect((await guard("snapshot")).text).toContain("status: recorded")
    await fs.writeFile(path.join(repo, "sample.txt"), "corrected output\n")
    expect((await guard("compare")).text).toContain("status: ok")
    expect((await ledger("set_verdict", { v: "pass", via: "worker" })).error).toBeUndefined()
    const saved = JSON.parse(await fs.readFile(path.join(dir, "ledger.json"), "utf8"))
    expect(saved.phases.p1.units.u1.delegations[1]).toMatchObject({ attempt: 2, worker_id: "native-worker-1", session_id: "s1", model_rank: { weight: 3 } })
    await call(client, "write_journal", { operation: "declare_model", data: { model: "Sol" } })
    const denied = await ledger("set_unit_status", {
      s: "delegated", brief: "Correct sample text while preserving the agreed scope.", preflight,
      worker_id: "native-worker-1", correction: { kind: "bounded", from_attempt: 2, files: ["sample.txt"] },
    })
    expect(denied.error).toBe(true)
    expect(denied.text).toContain("normal Foreman protocol")
  })
})
