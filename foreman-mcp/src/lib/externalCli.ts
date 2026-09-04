import { spawn } from 'child_process'
import path from 'path'

export const MAX_OUTPUT = 16000

export interface ExternalCliResult {
  stdout: string
  stderr: string
  timedOut: boolean
  exitCode: number
  /** Either stream hit MAX_OUTPUT. Kept for callers that predate the per-stream flags. */
  truncated: boolean
  /** Per-stream truncation (v0.6.1). Lets formatters drop a noisy-but-complete stderr when stdout is intact. */
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export function runExternalCli(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ExternalCliResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let stdoutTruncated = false
    let stderrTruncated = false

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Close stdin immediately to signal EOF to the child process
    child.stdin.end()

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT) {
        stdout = '...(truncated)\n' + stdout.slice(-MAX_OUTPUT)
        stdoutTruncated = true
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_OUTPUT) {
        stderr = '...(truncated)\n' + stderr.slice(-MAX_OUTPUT)
        stderrTruncated = true
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
      resolve({ stdout, stderr: err.message, timedOut: false, exitCode: -1, truncated: false })
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (settled) return
      settled = true
      if (timedOut) {
        resolve({ stdout, stderr, timedOut: true, exitCode: -1, truncated: stdoutTruncated || stderrTruncated, stdoutTruncated, stderrTruncated })
      } else {
        resolve({ stdout, stderr, timedOut: false, exitCode: code ?? 1, truncated: stdoutTruncated || stderrTruncated, stdoutTruncated, stderrTruncated })
      }
    })
  })
}

// ── Cross-platform CLI resolution ──────────────────────────────────────────────

export const RESOLVE_CMD = process.platform === 'win32' ? 'where' : 'which'

export interface SpawnPlan {
  command: string
  args: string[]
}

export type ResolveResult =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; reason: string }

const NATIVE_EXTS = new Set(['.exe', '.com'])
const SHIM_EXTS = new Set(['.cmd', '.bat'])

/** Split + trim lines from which/where output. Handles CRLF and LF. */
export function parseLines(raw: string): string[] {
  return raw
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** Cross-platform absolute path check — recognizes both POSIX and Windows paths. */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/')) return true
  if (/^[A-Za-z]:[/\\]/.test(p)) return true
  if (p.startsWith('\\\\')) return true
  return false
}

/** Parse which/where output into valid absolute paths. */
export function parseResolutionOutput(raw: string): string[] {
  return parseLines(raw).filter(isAbsolutePath)
}

/**
 * Resolve a CLI binary name to a SpawnPlan.
 * On POSIX: returns the absolute path directly.
 * On Windows: prefers native .exe/.com; wraps .cmd/.bat via cmd.exe /d /s /c.
 */
export async function resolveInvocation(cli: string): Promise<ResolveResult> {
  const result = await runExternalCli(RESOLVE_CMD, [cli], 3000)

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { ok: false, reason: `${cli} not found` }
  }

  const candidates = parseResolutionOutput(result.stdout)

  if (candidates.length === 0) {
    return { ok: false, reason: `${cli} resolved to non-absolute path` }
  }

  if (process.platform !== 'win32') {
    return { ok: true, plan: { command: candidates[0], args: [] } }
  }

  // Windows: prefer native .exe/.com over .cmd/.bat shims
  const natives: string[] = []
  const shims: string[] = []

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase()
    if (NATIVE_EXTS.has(ext)) {
      natives.push(candidate)
    } else if (SHIM_EXTS.has(ext)) {
      shims.push(candidate)
    }
  }

  if (natives.length > 0) {
    return { ok: true, plan: { command: natives[0], args: [] } }
  }

  if (shims.length > 0) {
    const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    return {
      ok: true,
      plan: { command: comspec, args: ['/d', '/s', '/c', shims[0]] },
    }
  }

  return { ok: false, reason: `${cli} resolved but no executable candidate found` }
}

// ── Spawn with stdin ───────────────────────────────────────────────────────────

/**
 * Like runExternalCli but writes stdinData to the child's stdin before closing.
 * Used for delivering prompts to advisor CLIs without hitting OS arg length limits.
 */
export function runWithStdin(
  command: string,
  args: string[],
  stdinData: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExternalCliResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let stdoutTruncated = false
    let stderrTruncated = false

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    })

    child.stdin.on('error', () => {
      // Swallow — child may have exited before reading all stdin
    })
    child.stdin.write(stdinData, 'utf-8')
    child.stdin.end()

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT) {
        stdout = '...(truncated)\n' + stdout.slice(-MAX_OUTPUT)
        stdoutTruncated = true
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_OUTPUT) {
        stderr = '...(truncated)\n' + stderr.slice(-MAX_OUTPUT)
        stderrTruncated = true
      }
    })

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 5000)
    }, timeoutMs)

    let killTimer: ReturnType<typeof setTimeout>

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ stdout, stderr: err.message, timedOut: false, exitCode: -1, truncated: false })
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (settled) return
      settled = true
      if (timedOut) {
        resolve({ stdout, stderr, timedOut: true, exitCode: -1, truncated: stdoutTruncated || stderrTruncated, stdoutTruncated, stderrTruncated })
      } else {
        resolve({ stdout, stderr, timedOut: false, exitCode: code ?? 1, truncated: stdoutTruncated || stderrTruncated, stdoutTruncated, stderrTruncated })
      }
    })
  })
}

// ── Python resolution + aider capability probe (Unit 3a) ───────────────────────

/**
 * Resolve a Python interpreter, preferring an explicit override, then `python3`, then
 * `python`. Returns the first that resolves. `python3` is not present on every host
 * (e.g. Windows installs only `python`), so we try both.
 */
export async function resolvePython(preferred?: string): Promise<ResolveResult> {
  const candidates = [preferred, "python3", "python"].filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0,
  )
  let lastReason = "no python interpreter candidate configured"
  for (const cand of candidates) {
    const r = await resolveInvocation(cand)
    if (r.ok) return r
    lastReason = r.reason
  }
  return { ok: false, reason: lastReason }
}

export type AiderProbeResult =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; missing: "python" | "aider"; reason: string }

/**
 * capability_check-style pre-flight for the aider transport (decision #2, FAIL OPEN).
 * Resolves a python interpreter, then runs `<python> <harnessPath> --probe` (empty stdin)
 * and reads the sentinel exit code: 0 => aider importable; anything else => aider absent.
 * Returns the resolved SpawnPlan on success so the caller reuses it for the real run.
 * NEVER throws — a probe failure is a fail-open signal, not an error.
 */
export async function probeAiderCapability(
  pythonCmd: string | undefined,
  harnessPath: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<AiderProbeResult> {
  const resolved = await resolvePython(pythonCmd)
  if (!resolved.ok) return { ok: false, missing: "python", reason: resolved.reason }
  const res = await runWithStdin(
    resolved.plan.command,
    [...resolved.plan.args, harnessPath, "--probe"],
    "",
    timeoutMs,
    env,
  )
  if (!res.timedOut && res.exitCode === 0) return { ok: true, plan: resolved.plan }
  return { ok: false, missing: "aider", reason: `aider probe exit ${res.exitCode}` }
}

/**
 * Build a child-process environment for the harness/probe spawn that strips secret-
 * bearing variables ([CWE-200] Threat Model "Python harness process" row). The API key
 * reaches the harness ONLY via the stdin request (the harness self-injects it into
 * OPENAI_API_KEY), so the child never needs a secret via env. This is a DENYLIST (not an
 * allowlist) so OS-runtime vars and non-secret vars pass through unchanged — an allowlist
 * would drop platform-specific runtime vars and break spawns.
 *
 * Stripped: any var named in `secretVarNames` (case-insensitive), plus any var whose NAME
 * matches a secret pattern (KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/APIKEY/_AUTH).
 */
export function buildFilteredChildEnv(
  secretVarNames: string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const deny = new Set(secretVarNames.filter(Boolean).map((s) => s.toUpperCase()))
  const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_AUTH/i
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (deny.has(k.toUpperCase())) continue
    if (SECRET_NAME_RE.test(k)) continue
    out[k] = v
  }
  return out
}
