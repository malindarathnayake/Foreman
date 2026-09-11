#!/usr/bin/env node
/**
 * Publish smoke gate.
 *
 * Why this exists: the top npm-DOA failure modes are a broken `files` glob,
 * a `dist/` that never got built, or a `bin` entry pointing at the wrong
 * path — the package "publishes fine" (npm accepts the tarball) but a clean
 * `npm install` on someone else's machine can't actually serve its tools.
 * None of that shows up in unit tests, which run against `src/`, and it
 * doesn't show up in `npm publish --dry-run` either — that only prints what
 * *would* be packed, it never installs the tarball and runs it.
 *
 * The cheaper alternative — spawn the built server and check `--version` —
 * can't catch this class of bug: the bin starting proves the entry file
 * exists and parses, but says nothing about whether the packed tarball
 * actually contains what the tools need at runtime (skills/, docs/, the
 * vendored `context-crush` fork) or whether the tool registry that got
 * built is the one this release is supposed to ship. So this script does
 * the real thing: `npm pack` the package as it would actually be published,
 * `npm install` the resulting tarball into a scratch directory (a real
 * install — registry fetches and all), spawn the installed `foreman-mcp`
 * bin shim (the consumer entry path — this is what validates the
 * `package.json#bin` mapping end-to-end, not just that `dist/server.js`
 * happens to exist) with a scrubbed HOME/config environment (first-run
 * conditions), and speak real MCP JSON-RPC to it over stdio to confirm
 * `tools/list` returns exactly the tools this release is supposed to ship.
 *
 * Why EXPECTED_TOOLS is DUPLICATED here vs tests/integration.test.ts:
 * deliberate — dependency-freedom over DRY. This script must not import
 * test infra or src/: a broken build must not be able to take the checker
 * down with it (if `src/` itself fails to load, the smoke check still needs
 * to run and fail loudly rather than being dragged down by the same
 * breakage it exists to catch). tests/releaseInvariants.test.ts is the
 * drift guard that keeps this list and the live tool registry in sync.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import readline from "node:readline"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The 27 tools the live registry (src/server.ts) is expected to expose.
// Keep in sync manually — tests/releaseInvariants.test.ts fails the build
// the moment this drifts from the real tool list.
export const EXPECTED_TOOLS = [
  "bundle_status",
  "host_status",
  "changelog",
  "ethos",
  "read_ledger",
  "read_progress",
  "capability_check",
  "write_ledger",
  "write_progress",
  "normalize_review",
  "verify_citations",
  "pitboss_implementor",
  "design_partner",
  "spec_generator",
  "lighttask",
  "spec_man",
  "doc_man",
  "run_tests",
  "write_journal",
  "read_journal",
  "invoke_advisor",
  "session_orient",
  "retrieve_original",
  "preview_diagram",
  "invoke_worker",
  "invoke_council",
  "repo_guard",
  "claude_workflows_init",
  "preflight_check",
  "verify_oracle",
  "phase_ownership",
  "contract_probe",
  "worker_status",
  "live_smoke",
]

const JSONRPC_TIMEOUT_MS = 60_000

function log(message) {
  console.log(`[publish-smoke] ${message}`)
}

/** Run a command to completion, rejecting on non-zero exit. */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
          )
        )
      }
    })
  })
}

/**
 * Spawn the installed `foreman-mcp` bin shim directly (not `node <script>`
 * — the point is to exercise the same entry point a consumer's `npx
 * foreman-mcp` or PATH lookup would hit), speak the MCP handshake over
 * stdio (initialize -> notifications/initialized -> tools/list), and
 * resolve with both responses. Non-JSON stdout lines (banners, stray logs)
 * are ignored rather than treated as protocol errors.
 */
function runToolsListCheck(shimPath, cwd, env) {
  return new Promise((resolve, reject) => {
    // The .cmd shim npm generates on Windows requires shell:true to launch
    // (node >=18.20 EINVALs a bare .cmd spawn without it) — same
    // constraint as the npm.cmd calls in main(). No injection surface:
    // shimPath is a fixed, program-computed path and no args are passed.
    const useShell = process.platform === "win32"
    const child = spawn(shimPath, [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    })

    let settled = false
    let stderrBuf = ""
    let initializeResult = null
    let toolsListResult = null
    let activationResult = null
    let ethosResult = null

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners("exit")
      child.removeAllListeners("error")
      child.kill()
      fn(value)
    }

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(`Timed out after ${JSONRPC_TIMEOUT_MS}ms waiting for MCP handshake.\n--- stderr so far ---\n${stderrBuf}`)
      )
    }, JSONRPC_TIMEOUT_MS)

    function send(method, params, id) {
      const message = { jsonrpc: "2.0", method, params: params ?? {} }
      if (id !== undefined) message.id = id
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const rl = readline.createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      let message
      try {
        message = JSON.parse(trimmed)
      } catch {
        return // Not a JSON-RPC line (e.g. an incidental console.log) — ignore.
      }

      if (message.id === 1 && message.result) {
        initializeResult = message.result
        send("notifications/initialized")
        send("tools/list", {}, 2)
      } else if (message.id === 2 && message.result) {
        toolsListResult = message.result
        // R3 (2026-09): tools/list alone cannot see a missing src/skills or dist/docs —
        // activate one protocol and serve the ethos document from the INSTALLED package.
        send("tools/call", { name: "pitboss_implementor", arguments: { context: "publish smoke" } }, 3)
      } else if (message.id === 3 && message.result) {
        activationResult = message.result
        send("tools/call", { name: "ethos", arguments: {} }, 4)
      } else if (message.id === 4 && message.result) {
        ethosResult = message.result
        finish(resolve, { initializeResult, toolsListResult, activationResult, ethosResult })
      } else if (message.id !== undefined && message.error) {
        finish(reject, new Error(`Server returned a JSON-RPC error: ${JSON.stringify(message.error)}`))
      }
    })

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString()
    })
    child.on("error", (err) => {
      finish(reject, err)
    })
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(`Server process exited early (code ${code}) before completing the handshake.\n--- stderr ---\n${stderrBuf}`)
        )
      }
    })

    send(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "publish-smoke", version: "0.0.0" },
      },
      1
    )
  })
}

async function main() {
  const packageDir = path.resolve(__dirname, "..")
  const distServerPath = path.join(packageDir, "dist", "server.js")

  log(`checking build output at ${distServerPath}`)
  try {
    await access(distServerPath)
  } catch {
    throw new Error(`dist/server.js not found at ${distServerPath} — run npm run build first`)
  }

  const tempDirs = []
  try {
    // npm.cmd needs shell:true on Windows (node >=18.20 EINVALs a bare
    // .cmd spawn without it). Every argument passed below is a fixed,
    // program-controlled constant — no user input ever reaches argv — so
    // shell:true here carries no injection surface.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
    const useShell = process.platform === "win32"

    log("packing the package with npm pack")
    const packDir = await mkdtemp(path.join(os.tmpdir(), "foreman-smoke-pack-"))
    tempDirs.push(packDir)
    await runCommand(npmCmd, ["pack", "--pack-destination", packDir], {
      cwd: packageDir,
      shell: useShell,
    })
    const packedFiles = (await readdir(packDir)).filter((f) => f.endsWith(".tgz"))
    if (packedFiles.length !== 1) {
      throw new Error(`expected exactly one .tgz in ${packDir}, found: ${packedFiles.join(", ") || "(none)"}`)
    }
    const tarballPath = path.join(packDir, packedFiles[0])
    log(`packed ${packedFiles[0]}`)

    log("installing the tarball into a fresh directory")
    const installDir = await mkdtemp(path.join(os.tmpdir(), "foreman-smoke-install-"))
    tempDirs.push(installDir)
    // All runtime dependencies are bundled. Force offline mode so this gate
    // proves that a release tarball installs without registry/DNS access.
    await runCommand(npmCmd, ["install", tarballPath, "--no-save", "--prefix", installDir, "--offline"], {
      cwd: installDir,
      shell: useShell,
    })

    // The bin shim npm generates from package.json#bin — spawning this
    // (not dist/server.js directly) is what catches a broken bin mapping,
    // one of the npm-DOA failure modes this gate exists for.
    const shimPath = path.join(
      installDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "foreman-mcp.cmd" : "foreman-mcp"
    )
    try {
      await access(shimPath)
    } catch {
      throw new Error(`bin shim not found at ${shimPath} — broken package.json#bin?`)
    }

    log("spawning the installed bin shim (consumer entry path) with a scrubbed HOME/config environment")
    const scrubbedHome = await mkdtemp(path.join(os.tmpdir(), "foreman-smoke-home-"))
    tempDirs.push(scrubbedHome)
    const runCwd = await mkdtemp(path.join(os.tmpdir(), "foreman-smoke-run-"))
    tempDirs.push(runCwd)

    // Config isolation, NOT a security boundary: this catches first-run
    // bugs that only reproduce on a machine without the developer's own
    // Foreman/context-crush config lying around. PATH and everything else
    // pass through untouched — nothing here is sandboxing the child.
    const childEnv = { ...process.env }
    childEnv.HOME = scrubbedHome
    childEnv.USERPROFILE = scrubbedHome
    childEnv.APPDATA = path.join(scrubbedHome, "AppData", "Roaming")
    childEnv.LOCALAPPDATA = path.join(scrubbedHome, "AppData", "Local")
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("FOREMAN_") || key.startsWith("CONTEXT_CRUSH_")) {
        delete childEnv[key]
      }
    }

    log("speaking MCP JSON-RPC over stdio (initialize -> initialized -> tools/list -> activate -> ethos)")
    const { initializeResult, toolsListResult, activationResult, ethosResult } = await runToolsListCheck(shimPath, runCwd, childEnv)

    const version = initializeResult?.serverInfo?.version
    if (typeof version !== "string" || version.length === 0) {
      throw new Error("initialize response is missing a non-empty serverInfo.version")
    }
    log(`server reported version: ${version}`)

    const actualNames = (toolsListResult?.tools ?? []).map((t) => t.name).sort()
    const expectedNames = [...EXPECTED_TOOLS].sort()
    const missing = expectedNames.filter((name) => !actualNames.includes(name))
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name))

    if (missing.length > 0 || unexpected.length > 0) {
      if (missing.length > 0) log(`MISSING tools (expected but not returned): ${missing.join(", ")}`)
      if (unexpected.length > 0) log(`UNEXPECTED tools (returned but not expected): ${unexpected.join(", ")}`)
      throw new Error("tools/list from the packed+installed server did not match EXPECTED_TOOLS")
    }

    log(`tools/list matched all ${expectedNames.length} expected tools`)

    // ── R3: the runtime reads Markdown and assets from the package at run time ──
    const activationText = activationResult?.content?.[0]?.text ?? ""
    if (!activationText.includes("## Core Rules") || activationText.includes("{{") || activationText.includes("[MISSING")) {
      throw new Error(
        "pitboss_implementor activation from the installed package did not render cleanly " +
          "(src/skills missing from the tarball, or an unresolved include/placeholder):\n" +
          activationText.slice(0, 400)
      )
    }
    log("protocol activation rendered from the installed src/skills")

    const ethosText = ethosResult?.content?.[0]?.text ?? ""
    if (!ethosText.includes("# Engineering Ethos") || ethosText.includes("{{stack:")) {
      throw new Error("ethos did not render from the installed dist/docs:\n" + ethosText.slice(0, 400))
    }
    log("ethos rendered from the installed dist/docs")

    const pkgRoot = path.join(installDir, "node_modules", "@malindarathnayake", "foreman-mcp")
    const mustShip = [
      "package.json",
      "dist/server.js",
      "dist/docs/engineering-ethos.md",
      "dist/preview/template.html",
      "dist/preview/mermaid.min.js",
      "src/skills/implementor.md",
      "src/skills/_common-protocol.md",
    ]
    for (const rel of mustShip) {
      try {
        await access(path.join(pkgRoot, rel))
      } catch {
        throw new Error(`runtime file missing from the installed package: ${rel}`)
      }
    }
    const mustNotShip = ["bench", "scripts", "tests", "vendor", "src/server.ts", "src/preview", "src/docs", "tsconfig.json"]
    for (const rel of mustNotShip) {
      let present = true
      try {
        await access(path.join(pkgRoot, rel))
      } catch {
        present = false
      }
      if (present) throw new Error(`non-runtime path shipped in the package: ${rel}`)
    }
    log("installed package contains the runtime files and nothing else")

    const diag = await runCommand(shimPath, ["--diag"], { cwd: runCwd, env: childEnv, shell: useShell })
    // Diagnostics go to stderr: stdout is reserved for MCP framing.
    const diagText = diag.stdout + diag.stderr
    if (!/skills dir[\s\S]*?exists\s+true/.test(diagText)) {
      throw new Error("foreman-mcp --diag from the installed package did not resolve the skills dir:\n" + diagText.slice(0, 800))
    }
    log("--diag resolves the installed skills dir")

    log("publish smoke check PASSED")
  } finally {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`[publish-smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  )
}
