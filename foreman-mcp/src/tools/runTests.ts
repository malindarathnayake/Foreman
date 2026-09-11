import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { runExternalCli, RESOLVE_CMD, parseResolutionOutput, type SpawnPlan } from '../lib/externalCli.js'
import path from 'path'

export const DEFAULT_ALLOWED_RUNNERS = ["npm", "pytest", "go", "cargo", "dotnet", "make", "gradle", "gradlew", "gofmt", "golangci-lint"]
const BUFFER_CAP_MULTIPLIER = 4
const resolvedRunners = new Map<string, SpawnPlan>()

const NATIVE_EXTS = new Set(['.exe', '.com'])
const CMD_EXTS = new Set(['.cmd', '.bat'])

function getAllowedRunners(): string[] {
  const extra = process.env.FOREMAN_TEST_ALLOWLIST
  if (extra) {
    return [
      ...DEFAULT_ALLOWED_RUNNERS,
      ...extra.split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => /^[a-zA-Z0-9_.-]+$/.test(s))
        .filter(s => s.toLowerCase() !== 'npx')
    ]
  }
  return DEFAULT_ALLOWED_RUNNERS
}

export type RunnerResolution =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; error: string }

/**
 * Convert executable candidates into a safe spawn plan.
 *
 * On Windows, npm's extensionless bash shim cannot be spawned directly and
 * npm.cmd requires cmd.exe. Invoke npm-cli.js with Foreman's Node executable
 * instead, which keeps user-supplied arguments out of a shell.
 */
export function planFromCandidates(
  runner: string,
  candidates: string[],
  platform: NodeJS.Platform,
  fileExists: (candidate: string) => boolean,
): RunnerResolution {
  if (candidates.length === 0) {
    return { ok: false, error: `runner not found\nrunner: ${runner}` }
  }

  if (platform !== 'win32') {
    return { ok: true, plan: { command: candidates[0], args: [] } }
  }

  const windowsPath = path.win32
  const native = candidates.find((candidate) =>
    NATIVE_EXTS.has(windowsPath.extname(candidate).toLowerCase()),
  )
  if (native) {
    return { ok: true, plan: { command: native, args: [] } }
  }

  if (runner.toLowerCase() === 'npm') {
    const npmCliDirs = [
      ...candidates.map((candidate) => windowsPath.dirname(candidate)),
      windowsPath.dirname(process.execPath),
    ]
    for (const dir of [...new Set(npmCliDirs)]) {
      const npmCli = windowsPath.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (fileExists(npmCli)) {
        return { ok: true, plan: { command: process.execPath, args: [npmCli] } }
      }
    }
  }

  if (candidates.some((candidate) => CMD_EXTS.has(windowsPath.extname(candidate).toLowerCase()))) {
    return {
      ok: false,
      error: `runner resolves only to a .cmd shim on Windows; not spawnable safely\nrunner: ${runner}`,
    }
  }

  return {
    ok: false,
    error: `runner resolved but no executable candidate found\nrunner: ${runner}`,
  }
}

/**
 * Resolve a project-local Gradle wrapper without executing a shell or batch file.
 * POSIX can spawn the wrapper script directly through its shebang. Windows runs
 * GradleWrapperMain with java so user-controlled test args never cross cmd.exe.
 */
export function planGradleWrapper(
  projectRoot: string,
  platform: NodeJS.Platform,
  fileExists: (candidate: string) => boolean,
  javaCandidates: string[] = [],
): RunnerResolution | null {
  if (platform !== 'win32') {
    const wrapper = path.posix.join(projectRoot, 'gradlew')
    return fileExists(wrapper) ? { ok: true, plan: { command: wrapper, args: [] } } : null
  }

  const windowsPath = path.win32
  const wrapper = windowsPath.join(projectRoot, 'gradlew.bat')
  if (!fileExists(wrapper)) return null

  const wrapperJar = windowsPath.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (!fileExists(wrapperJar)) {
    return { ok: false, error: `gradle wrapper jar not found\npath: ${wrapperJar}` }
  }

  const java = planFromCandidates('java', javaCandidates, platform, fileExists)
  if (!java.ok) {
    return { ok: false, error: `java required for safe Windows gradlew execution\n${java.error}` }
  }

  return {
    ok: true,
    plan: {
      command: java.plan.command,
      args: [
        ...java.plan.args,
        '-Dorg.gradle.appname=gradlew',
        '-classpath',
        wrapperJar,
        'org.gradle.wrapper.GradleWrapperMain',
      ],
    },
  }
}

async function commandCandidates(command: string): Promise<string[]> {
  const result = await runExternalCli(RESOLVE_CMD, [command], 3000)
  if (result.exitCode !== 0 || !result.stdout.trim()) return []
  return parseResolutionOutput(result.stdout)
}

async function resolveRunner(runner: string): Promise<RunnerResolution> {
  const lower = runner.toLowerCase()
  const projectRoot = process.cwd()
  const cacheKey = lower === 'gradle' || lower === 'gradlew' ? `${lower}\0${projectRoot}` : runner
  const cached = resolvedRunners.get(cacheKey)
  if (cached) return { ok: true, plan: cached }

  if (lower === 'gradle' || lower === 'gradlew') {
    const javaCandidates = process.platform === 'win32' ? await commandCandidates('java') : []
    const wrapper = planGradleWrapper(projectRoot, process.platform, existsSync, javaCandidates)
    if (wrapper !== null) {
      if (wrapper.ok) resolvedRunners.set(cacheKey, wrapper.plan)
      return wrapper
    }
    if (lower === 'gradlew') {
      return { ok: false, error: `project-local gradle wrapper not found\npath: ${projectRoot}` }
    }
  }

  const candidates = await commandCandidates(runner)
  if (candidates.length === 0) {
    return { ok: false, error: `runner not found\nrunner: ${runner}` }
  }

  const resolution = planFromCandidates(
    runner,
    candidates,
    process.platform,
    existsSync,
  )
  if (resolution.ok) {
    resolvedRunners.set(cacheKey, resolution.plan)
  }
  return resolution
}

function truncate(buf: string, max: number): { text: string; wasTruncated: boolean } {
  if (buf.length <= max) return { text: buf, wasTruncated: false }
  return { text: '...(truncated)\n' + buf.slice(-max), wasTruncated: true }
}

// ─── Output shaping (field feedback 2026-09 round 2) ───────────────────────────
// A testcontainers banner ate a third of the output budget on every integration
// run. Callers can now drop known noise by regex and/or keep only the tail, both
// applied per stream BEFORE the character cap so the budget goes to signal.

export interface OutputFilterOptions {
  /** JS regex sources (no flags, case-sensitive). A line matching any is dropped. */
  stripPatterns?: string[]
  /** Keep only the last N lines of each stream. */
  tailLines?: number
  /**
   * Treat any non-empty stdout as a failure even on exit 0. For list-style checkers
   * (`gofmt -l`, `goimports -l`) that exit 0 and print the files needing work — without
   * this, `passed: true` would lie (field feedback 2026-09 round 3).
   */
  failOnStdout?: boolean
}

export const MAX_STRIP_PATTERNS = 10
export const MAX_STRIP_PATTERN_LENGTH = 200

export function compileStripPatterns(
  patterns: string[] | undefined
): { ok: true; regexes: RegExp[] } | { ok: false; error: string } {
  if (!patterns || patterns.length === 0) return { ok: true, regexes: [] }
  if (patterns.length > MAX_STRIP_PATTERNS) {
    return { ok: false, error: `too many strip_patterns (${patterns.length}); max ${MAX_STRIP_PATTERNS}` }
  }
  const regexes: RegExp[] = []
  for (const p of patterns) {
    if (p.length === 0 || p.length > MAX_STRIP_PATTERN_LENGTH) {
      return { ok: false, error: `invalid strip_pattern length (${p.length}); must be 1..${MAX_STRIP_PATTERN_LENGTH}` }
    }
    try {
      regexes.push(new RegExp(p))
    } catch (err) {
      return { ok: false, error: `invalid strip_pattern\npattern: ${p}\n${(err as Error).message}` }
    }
  }
  return { ok: true, regexes }
}

/** Pure: drop matching lines, then keep the tail. Returns the shaped text and how many lines were stripped. */
export function applyOutputFilters(
  buf: string,
  regexes: RegExp[],
  tailLines?: number
): { text: string; strippedLines: number } {
  if (regexes.length === 0 && tailLines === undefined) return { text: buf, strippedLines: 0 }
  let lines = buf.split('\n')
  let strippedLines = 0
  if (regexes.length > 0) {
    const kept = lines.filter((line) => !regexes.some((re) => re.test(line)))
    strippedLines = lines.length - kept.length
    lines = kept
  }
  if (tailLines !== undefined && lines.length > tailLines) {
    lines = lines.slice(-tailLines)
  }
  return { text: lines.join('\n'), strippedLines }
}

/**
 * 0.6.20 (field report): a project that pins its toolchain (bin/go1.26.8-verified/go/bin/go.exe
 * because the system go cannot build the module) was refused, and the workaround was a
 * Docker harness. A path-shaped runner is allowed when it stays inside the project root,
 * exists as a file, and its basename (without .exe/.cmd/.bat) is an allowed runner. The
 * allowlist still names what may run; the path only says where the pinned copy lives.
 */
export function pinnedToolchain(
  runner: string,
  allowed: string[],
  projectRoot: string = process.cwd(),
): { ok: true; command: string } | { ok: false; error: string } | null {
  if (!/[\\/]/.test(runner)) return null
  const abs = path.resolve(projectRoot, runner)
  const rel = path.relative(projectRoot, abs)
  const refuse = (reason: string) => ({
    ok: false as const,
    error: `runner not in allowlist\nrunner: ${runner}\nreason: ${reason}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`,
  })
  if (rel.startsWith('..') || path.isAbsolute(rel)) return refuse('a pinned runner must live inside the project root')
  const base = path.basename(abs).replace(/\.(exe|cmd|bat)$/i, '')
  if (!allowed.includes(base)) return refuse(`pinned runner basename '${base}' is not an allowed runner`)
  if (!existsSync(abs)) return refuse(`pinned runner not found at ${abs}`)
  return { ok: true, command: abs }
}

export async function runTests(
  runner: string,
  args: string[],
  timeoutMs: number = 60000,
  maxOutputChars: number = 8000,
  filters?: OutputFilterOptions,
  /** 0.6.21: working directory for the child (verify_oracle runs in its repo_root); default the server cwd. */
  cwd?: string,
  /** 0.6.23: variables laid over the server environment for the child (live_smoke plan env from the credential store). */
  env?: Record<string, string>,
): Promise<string> {
  const allowedRunners = getAllowedRunners()
  const pinned = pinnedToolchain(runner, allowedRunners, cwd ?? process.cwd())
  if (pinned && !pinned.ok) return `error: ${pinned.error}`
  if (!pinned && !allowedRunners.includes(runner)) {
    return Promise.resolve(
      `error: runner not in allowlist\nrunner: ${runner}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
    )
  }

  const compiled = compileStripPatterns(filters?.stripPatterns)
  if (!compiled.ok) {
    return `error: ${compiled.error}`
  }
  const regexes = compiled.regexes
  const finalize = (buf: string) => {
    const shaped = applyOutputFilters(buf, regexes, filters?.tailLines)
    return { ...truncate(shaped.text, maxOutputChars), stripped: shaped.strippedLines }
  }
  // Meta lines appear ONLY when shaping was requested, so default output stays byte-identical.
  const shapingMeta = (a: { stripped: number }, b: { stripped: number }): string => {
    const parts: string[] = []
    if (filters?.stripPatterns?.length) parts.push(`stripped_lines: ${a.stripped + b.stripped}`)
    if (filters?.tailLines !== undefined) parts.push(`tail_lines: ${filters.tailLines}`)
    if (filters?.failOnStdout) parts.push("fail_on_stdout: true")
    return parts.length ? parts.join('\n') + '\n' : ''
  }

  const resolution: RunnerResolution = pinned && pinned.ok
    ? { ok: true, plan: { command: pinned.command, args: [] } }
    : await resolveRunner(runner)
  if (!resolution.ok) {
    return `error: ${resolution.error}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
  }

  return new Promise((resolve) => {
    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    let timedOut = false

    const child = spawn(resolution.plan.command, [...resolution.plan.args, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
    })

    child.stdin.end()

    const hardCap = BUFFER_CAP_MULTIPLIER * maxOutputChars

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutBuf += chunk.toString()
      if (stdoutBuf.length > hardCap || stderrBuf.length > hardCap) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
          const out = finalize(stdoutBuf)
          const errOut = finalize(stderrBuf)
          resolve(
            `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n${shapingMeta(out, errOut)}\nSTDOUT\n${out.text}\n\nSTDERR\n${errOut.text}`
          )
        }
        return
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrBuf += chunk.toString()
      if (stdoutBuf.length > hardCap || stderrBuf.length > hardCap) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
          const out = finalize(stdoutBuf)
          const errOut = finalize(stderrBuf)
          resolve(
            `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n${shapingMeta(out, errOut)}\nSTDOUT\n${out.text}\n\nSTDERR\n${errOut.text}`
          )
        }
        return
      }
    })

    // Timeout: SIGTERM first, then SIGKILL after 5s grace period
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill('SIGTERM')

      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Process may have already exited
        }
      }, 5000)
    }, timeoutMs)

    let killTimer: ReturnType<typeof setTimeout>

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const output =
        `exit_code: -1\n` +
        `passed: false\n` +
        `timed_out: false\n` +
        `truncated: false\n` +
        `\nSTDOUT\n` +
        `\n\nSTDERR\n` +
        err.message
      resolve(output)
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (settled) return
      settled = true

      const out = finalize(stdoutBuf)
      const errOut = finalize(stderrBuf)
      const truncated = out.wasTruncated || errOut.wasTruncated

      const exitCode = timedOut ? -1 : (code ?? 1)
      const stdoutFailure = filters?.failOnStdout === true && stdoutBuf.trim().length > 0
      const passed = !timedOut && exitCode === 0 && !stdoutFailure

      const output =
        `exit_code: ${exitCode}\n` +
        `passed: ${passed}\n` +
        `timed_out: ${timedOut}\n` +
        `truncated: ${truncated}\n` +
        shapingMeta(out, errOut) +
        `\nSTDOUT\n` +
        out.text +
        `\n\nSTDERR\n` +
        errOut.text

      resolve(output)
    })
  })
}
