import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { codexAgentsInit } from "../src/tools/codexAgentsInit.js"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agents-init-"))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("codexAgentsInit", () => {
  it("writes config.toml and explorer/worker role TOMLs", async () => {
    const out = await codexAgentsInit({ project_dir: tmpDir })
    expect(out).toContain("status: ok")
    expect(out).toContain("files_written: .codex/config.toml,.codex/agents/explorer.toml,.codex/agents/worker.toml")

    const config = await fs.readFile(path.join(tmpDir, ".codex", "config.toml"), "utf-8")
    expect(config).toContain("[agents]")
    expect(config).toContain("max_threads = 6")
    expect(config).toContain("max_depth = 1")

    const explorer = await fs.readFile(path.join(tmpDir, ".codex", "agents", "explorer.toml"), "utf-8")
    expect(explorer).toContain('name = "explorer"')
    expect(explorer).toContain('sandbox_mode = "read-only"')
    expect(explorer).toContain("Stay in exploration mode")
    expect(explorer).not.toContain("model =")

    const worker = await fs.readFile(path.join(tmpDir, ".codex", "agents", "worker.toml"), "utf-8")
    expect(worker).toContain('name = "worker"')
    expect(worker).toContain('sandbox_mode = "workspace-write"')
    expect(worker).toContain("Do not spawn further subagents")
    expect(worker).not.toContain("model =")
  })

  it("skips existing role files when overwrite is false", async () => {
    await codexAgentsInit({ project_dir: tmpDir })
    await fs.writeFile(
      path.join(tmpDir, ".codex", "agents", "explorer.toml"),
      'name = "explorer"\ndescription = "custom"\n',
      "utf-8"
    )

    const out = await codexAgentsInit({ project_dir: tmpDir, overwrite: false })
    expect(out).toContain(".codex/agents/explorer.toml")
    expect(out).toMatch(/files_skipped:.*explorer\.toml/)

    const explorer = await fs.readFile(path.join(tmpDir, ".codex", "agents", "explorer.toml"), "utf-8")
    expect(explorer).toContain('description = "custom"')
  })

  it("never overwrites an existing config.toml; returns merge hint when [agents] missing", async () => {
    await fs.mkdir(path.join(tmpDir, ".codex"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".codex", "config.toml"),
      'model = "gpt-5.4"\n\n[mcp_servers.foreman]\ncommand = "foreman-mcp"\n',
      "utf-8"
    )

    const out = await codexAgentsInit({ project_dir: tmpDir, max_threads: 3 })
    expect(out).toContain("files_skipped:")
    expect(out).toContain(".codex/config.toml")
    expect(out).toContain("append manually")
    expect(out).toContain("max_threads = 3")

    const config = await fs.readFile(path.join(tmpDir, ".codex", "config.toml"), "utf-8")
    expect(config).toContain("[mcp_servers.foreman]")
    expect(config).not.toContain("[agents]")
  })

  it("warns when max_depth > 1", async () => {
    const out = await codexAgentsInit({ project_dir: tmpDir, max_depth: 2 })
    expect(out).toContain("max_depth>1")
    expect(out).toContain("max_depth: 2")
  })

  it("writes only requested roles subset", async () => {
    const out = await codexAgentsInit({ project_dir: tmpDir, roles: ["explorer"] })
    const writtenLine = out.split(/\r?\n/).find((l) => l.startsWith("files_written:")) ?? ""
    expect(writtenLine).toContain(".codex/agents/explorer.toml")
    expect(writtenLine).not.toContain("worker.toml")

    await expect(fs.access(path.join(tmpDir, ".codex", "agents", "explorer.toml"))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpDir, ".codex", "agents", "worker.toml"))).rejects.toThrow()
  })

  it("pins model only when caller provides models override", async () => {
    await codexAgentsInit({
      project_dir: tmpDir,
      models: { worker: "gpt-5.6-luna" },
    })
    const worker = await fs.readFile(path.join(tmpDir, ".codex", "agents", "worker.toml"), "utf-8")
    expect(worker).toContain('model = "gpt-5.6-luna"')
    const explorer = await fs.readFile(path.join(tmpDir, ".codex", "agents", "explorer.toml"), "utf-8")
    expect(explorer).not.toContain("model =")
  })

  it("errors when project_dir is missing or not a directory", async () => {
    const missing = path.join(tmpDir, "nope")
    const out = await codexAgentsInit({ project_dir: missing })
    expect(out).toContain("status: error")
    expect(out).toContain("project_dir_invalid")
  })

  it("overwrites role TOMLs when overwrite is true", async () => {
    await codexAgentsInit({ project_dir: tmpDir })
    await fs.writeFile(
      path.join(tmpDir, ".codex", "agents", "worker.toml"),
      'name = "worker"\ndescription = "stale"\n',
      "utf-8"
    )
    const out = await codexAgentsInit({ project_dir: tmpDir, overwrite: true, roles: ["worker"] })
    expect(out).toContain(".codex/agents/worker.toml")
    expect(out).not.toMatch(/files_skipped:.*worker/)
    const worker = await fs.readFile(path.join(tmpDir, ".codex", "agents", "worker.toml"), "utf-8")
    expect(worker).toContain("Execution-focused worker")
    expect(worker).not.toContain("stale")
  })
})
