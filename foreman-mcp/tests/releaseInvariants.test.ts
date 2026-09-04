import { describe, it, expect, afterEach } from "vitest"
import fs from "fs/promises"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"

// The smoke script is the single owner of the expected-tool list (1g); this
// invariant makes drift between that list and the live registry a test failure.
// @ts-expect-error — plain .mjs module without type declarations
import { EXPECTED_TOOLS } from "../scripts/publish-smoke.mjs"

let server: McpServer
let client: Client

async function setupServer(): Promise<void> {
  server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "release-invariants-test", version: "1.0.0" })
  await client.connect(clientTransport)
}

afterEach(async () => {
  await client?.close()
  await server?.close()
})

async function readPackageJson(): Promise<{ version: string }> {
  const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf-8")
  return JSON.parse(raw) as { version: string }
}

async function readRootChangelog(): Promise<string> {
  return fs.readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf-8")
}

async function readRootFile(name: string): Promise<string> {
  return fs.readFile(new URL(`../../${name}`, import.meta.url), "utf-8")
}

// R3 (2026-09): the tarball ships only what the runtime reads. `files` in package.json
// is the whitelist; this test pins the packed manifest so a benchmark, fixture, planning
// note, source map, or stale compiled module cannot leak back in. Runs `npm pack --dry-run`
// against the built tree (CI builds before testing).
describe("packed manifest", () => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url))
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"

  function packedPaths(): string[] {
    const out = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageDir,
      shell: process.platform === "win32",
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const manifest = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
    return manifest[0].files.map((f) => f.path)
  }

  it("ships the runtime files and the bundled dependencies", () => {
    const paths = packedPaths()
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "HOST-CONTRACT.md",
      "dist/server.js",
      "dist/docs/engineering-ethos.md",
      "dist/preview/template.html",
      "dist/preview/mermaid.min.js",
      "src/skills/implementor.md",
      "src/skills/_common-protocol.md",
      "src/skills/_assists.md",
    ]) {
      expect(paths, required).toContain(required)
    }
    expect(paths.some((p) => p.startsWith("node_modules/zod/")), "bundled zod").toBe(true)
    expect(paths.some((p) => p.startsWith("node_modules/context-crush/")), "bundled context-crush").toBe(true)
  })

  it("ships nothing the runtime does not read", () => {
    const own = packedPaths().filter((p) => !p.startsWith("node_modules/"))
    const forbidden: Array<[string, RegExp]> = [
      ["bench", /^bench\//],
      ["scripts", /^scripts\//],
      ["tests", /^tests\//],
      ["TypeScript sources", /^src\/.*\.ts$/],
      ["src/preview duplicate", /^src\/preview\//],
      ["src/docs duplicate", /^src\/docs\//],
      ["vendor tree", /^vendor\//],
      ["source maps", /\.map$/],
      ["declarations", /\.d\.ts$/],
      ["tarballs", /\.tgz$/],
      ["planning notes", /CONTEXT-BOUNDARY/],
      ["tsconfig", /^tsconfig/],
      ["vitest config", /^vitest\.config/],
      ["python bytecode", /\.pyc$|__pycache__/],
      ["aider remnants (removed in 0.6.3)", /aider/i],
    ]
    for (const [label, re] of forbidden) {
      const hits = own.filter((p) => re.test(p))
      expect(hits, label).toEqual([])
    }
  })
})

describe("release invariants", () => {
  it("package.json version === server-reported version", async () => {
    await setupServer()
    const pkg = await readPackageJson()
    expect(client.getServerVersion()?.version).toBe(pkg.version)
  })

  it("package.json version === newest CHANGELOG heading", async () => {
    const pkg = await readPackageJson()
    const changelog = await readRootChangelog()
    const match = changelog.match(/^## (\d+\.\d+\.\d+)/m)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe(pkg.version)
  })

  it("every workflow pins node-version 22", async () => {
    const workflowsDir = new URL("../../.github/workflows/", import.meta.url)
    const entries = await fs.readdir(workflowsDir)
    const workflowFiles = entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    expect(workflowFiles.length).toBeGreaterThan(0)

    let occurrences = 0
    for (const file of workflowFiles) {
      const contents = await fs.readFile(new URL(file, workflowsDir), "utf-8")
      const matches = contents.matchAll(/node-version:\s*['"]?([^\s'"]+)['"]?/g)
      for (const m of matches) {
        occurrences += 1
        expect(m[1]).toBe("22")
      }
    }
    expect(occurrences).toBeGreaterThan(0)
  })

  it("publish-smoke EXPECTED_TOOLS matches the live registry", async () => {
    await setupServer()
    const result = await client.listTools()
    const actualNames = result.tools.map((t) => t.name).sort()
    const expectedNames = [...EXPECTED_TOOLS].sort()
    expect(actualNames).toEqual(expectedNames)
  })

  it('README "Current release" line agrees with package.json', async () => {
    const pkg = await readPackageJson()
    const readme = await readRootFile("README.md")
    const match = readme.match(/\*\*Current release:\*\* `v(\d+\.\d+\.\d+)`/)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe(pkg.version)
  })

  it("llms.txt tool count agrees with the live registry", async () => {
    await setupServer()
    const llmsTxt = await readRootFile("llms.txt")
    const match = llmsTxt.match(/Tool count: (\d+)/)
    expect(match).not.toBeNull()
    const result = await client.listTools()
    expect(Number(match?.[1])).toBe(result.tools.length)
    for (const tool of result.tools) {
      expect(llmsTxt).toContain(tool.name)
    }
  })
})
