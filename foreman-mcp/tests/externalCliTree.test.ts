// 0.6.39: a timeout or cancel must stop the whole process tree, and the call must return
// even when a grandchild still holds the pipes (Windows .cmd shims run through cmd.exe).
import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runExternalCli, runWithStdin } from "../src/lib/externalCli.js"

// A script file, not node -e: Node's Windows argument quoting mangles an inline script
// passed through cmd /s /c, and the "sleeper" would exit at once.
const script = path.join(os.tmpdir(), "foreman-tree-sleeper60.js").split(path.sep).join("/")
fs.writeFileSync(script, "setTimeout(()=>{},60000); console.log('sleeping')\n")
const sleeper = process.platform === "win32"
  ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", "node", script] }
  : { cmd: "sh", args: ["-c", `node ${script}; true`] }

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const nodeChildrenOf = (marker: string) => {
  if (process.platform !== "win32") return 0
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`], { encoding: "utf-8" })
  return Number(out.trim() || "0")
}

describe("process tree on timeout and cancel", () => {
  it("a timeout returns promptly and leaves no grandchild running", async () => {
    const t = Date.now()
    const r = await runExternalCli(sleeper.cmd, sleeper.args, 800)
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t).toBeLessThan(10_000)
    await new Promise((res) => setTimeout(res, 1500))
    expect(nodeChildrenOf("foreman-tree-sleeper60")).toBe(0)
  }, 20_000)

  it("aborting the signal cancels the run and reports cancelled", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    const t = Date.now()
    const r = await runWithStdin(sleeper.cmd, sleeper.args, "ignored", 60_000, undefined, { signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(r.exitCode).toBe(-1)
    expect(Date.now() - t).toBeLessThan(10_000)
  }, 20_000)

  it("an already-aborted signal never starts the child", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runExternalCli(sleeper.cmd, sleeper.args, 60_000, { signal: ac.signal })
    expect(r.cancelled).toBe(true)
  })

  it("a normal run is unchanged", async () => {
    const r = await runExternalCli("node", ["-e", "console.log('hi'); process.exit(3)"], 10_000)
    expect(r.stdout.trim()).toBe("hi")
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(alive(process.pid)).toBe(true)
  })
})

// Codex review of 0.6.39: when the child exits but a descendant still holds the pipes, the
// drain expiring is NOT a clean exit — output may be missing.
describe("exit with the pipes still held", () => {
  it.skipIf(process.platform !== "win32")("reports incomplete output as a timeout, never as success", async () => {
    const t = Date.now()
    const r = await runExternalCli("cmd.exe", ["/d", "/s", "/c", "start", "\"\"", "/b", "node", script], 30_000)
    try {
      expect(r.timedOut).toBe(true)
      expect(r.exitCode).toBe(-1)
      expect(r.stderr).toContain("output incomplete")
      expect(Date.now() - t).toBeLessThan(10_000)
    } finally {
      execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*foreman-tree-sleeper60*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
    }
  }, 30_000)
})
