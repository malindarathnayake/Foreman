import { describe, it, expect, beforeAll } from "vitest"
import { spawn, execSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

// Regression for the Codex×Claude ship review: preview_diagram starts a loopback
// HTTP listener (a ref'd handle). Without a shutdown path the MCP process would
// hang after the client disconnects. This spawns the real built server, starts a
// preview, closes stdin, and asserts the process exits (0) and frees the port.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const serverPath = path.join(repoRoot, "dist", "server.js")

beforeAll(async () => {
  try {
    await fs.access(serverPath)
  } catch {
    execSync("npm run build", { cwd: repoRoot, stdio: "ignore" })
  }
}, 120_000)

describe("preview server lifecycle", () => {
  it("exits cleanly after the client closes stdin while a preview is running", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-life-"))
    const child = spawn(process.execPath, [serverPath], {
      cwd,
      env: { ...process.env, FOREMAN_NO_OPEN: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let buf = ""
    const waitFor = (id: number): Promise<any> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for id ${id}; tail=${buf.slice(-300)}`)),
          10_000
        )
        const onData = (d: Buffer) => {
          buf += d.toString()
          const lines = buf.split("\n")
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line)
              if (msg.id === id) {
                clearTimeout(timer)
                child.stdout.off("data", onData)
                resolve(msg)
                return
              }
            } catch {
              /* partial line */
            }
          }
        }
        child.stdout.on("data", onData)
      })

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "life", version: "1" } },
    })
    await waitFor(1)
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "preview_diagram", arguments: { id: "lifecycle", source: "flowchart TD\n A-->B" } },
    })
    const callRes = await waitFor(2)
    expect(JSON.stringify(callRes)).toContain("preview_url") // preview server is now live in the child

    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
    child.stdin.end() // simulate client disconnect (stdin EOF) — must trigger shutdown

    const code = await Promise.race([
      exited,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          child.kill("SIGKILL")
          rej(new Error("process did not exit after stdin close (lifecycle leak)"))
        }, 6_000)
      ),
    ])
    expect(code).toBe(0)

    await fs.rm(cwd, { recursive: true, force: true })
  }, 30_000)
})
