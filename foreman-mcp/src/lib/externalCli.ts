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
  /** 0.6.39: the caller's AbortSignal fired (host cancelled the request or disconnected). */
  cancelled?: boolean
  /** 0.6.39: the seat ran on a fallback model because the first was not available. */
  modelFallback?: { from: string; to: string; reason: string; first: Omit<ExternalCliResult, "modelFallback"> }
}

/** 0.6.39: per-call controls shared by runExternalCli and runWithStdin. */
export interface SpawnControls {
  /** Aborting kills the whole process tree and resolves with cancelled: true. */
  signal?: AbortSignal
  /** Called every PROGRESS_TICK_MS while the child runs, with elapsed milliseconds. */
  onTick?: (elapsedMs: number) => void
}
export const PROGRESS_TICK_MS = 20_000

/** Hard ceiling on a caller-raised stdout budget (v0.6.12). */
export const MAX_OUTPUT_CEILING = 2_000_000

export function runExternalCli(
  command: string,
  args: string[],
  timeoutMs: number,
  opts?: { maxStdout?: number } & SpawnControls,
): Promise<ExternalCliResult> {
  // Advisor and test output is prose a model reads, so 16 KB is the right budget there.
  // Machine-readable inventories (a repository's changed-path list) are bounded by the
  // caller's own limit instead, and truncating them silently would be a correctness bug
  // rather than a display one — hence an explicit, ceilinged opt-in.
  const stdoutBudget = Math.min(Math.max(opts?.maxStdout ?? MAX_OUTPUT, MAX_OUTPUT), MAX_OUTPUT_CEILING)
  return spawnCollect(command, args, { stdin: null, timeoutMs, stdoutBudget, signal: opts?.signal, onTick: opts?.onTick })
}

/**
 * Kill a child and everything it started (0.6.39). Advisor CLIs on Windows are npm .cmd shims
 * run through cmd.exe, so killing the direct child left node/claude/codex running and holding
 * the inherited pipes — the call hung past its timeout, because 'close' waits for every holder
 * of the pipe. taskkill /T walks the tree from the pid NOW, before the parent is gone, so it
 * runs first and only while the child has not exited (a reused pid is a microsecond race).
 * Elsewhere the child leads its own process group (detached) and the group is signalled.
 */
export function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T walks the tree from a LIVE parent; once it has exited there is nothing to walk.
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      tk.on('error', () => { try { child.kill() } catch { /* already gone */ } })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  // POSIX: the group outlives its leader, so it is signalled even after the leader exited
  // (0.6.39, Codex review: a SIGTERM-ignoring grandchild survived the escalation).
  try {
    process.kill(-child.pid, signal)
  } catch {
    // ESRCH: the group is gone; or the child is not a group leader — signal it alone.
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/** After the child exits, how long to wait for its pipes to close before resolving anyway. */
const EXIT_DRAIN_MS = 2_000

function spawnCollect(
  command: string,
  args: string[],
  o: { stdin: string | null; timeoutMs: number; stdoutBudget: number; env?: NodeJS.ProcessEnv } & SpawnControls,
): Promise<ExternalCliResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let cancelled = false
    let stdoutTruncated = false
    let stderrTruncated = false
    let exitCode: number | null = null
    const started = Date.now()

    if (o.signal?.aborted) {
      resolve({ stdout: '', stderr: 'cancelled before start', timedOut: false, exitCode: -1, truncated: false, cancelled: true })
      return
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: lead a process group so the whole tree can be signalled; Windows uses taskkill /T.
      detached: process.platform !== 'win32',
      ...(o.env ? { env: o.env } : {}),
    })

    child.stdin?.on('error', () => {
      // Swallow — child may have exited before reading all stdin
    })
    if (o.stdin !== null) child.stdin?.write(o.stdin, 'utf-8')
    child.stdin?.end()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > o.stdoutBudget) {
        stdout = '...(truncated)\n' + stdout.slice(-o.stdoutBudget)
        stdoutTruncated = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_OUTPUT) {
        stderr = '...(truncated)\n' + stderr.slice(-MAX_OUTPUT)
        stderrTruncated = true
      }
    })

    let killTimer: ReturnType<typeof setTimeout> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      killTree(child, 'SIGTERM')
      // Unref'd and never cleared on settlement: escalation must reach a descendant that
      // ignored SIGTERM even after the caller has its result.
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000)
      killTimer.unref?.()
    }
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      stop()
    }, o.timeoutMs)
    const tick = o.onTick ? setInterval(() => { try { o.onTick!(Date.now() - started) } catch { /* progress is best-effort */ } }, PROGRESS_TICK_MS) : undefined
    const onAbort = () => {
      if (settled) return
      cancelled = true
      stop()
    }
    o.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (result: ExternalCliResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      if (tick) clearInterval(tick)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const outcome = (code: number | null, incomplete = false): ExternalCliResult => {
      const truncated = stdoutTruncated || stderrTruncated
      // 0.6.39 (Codex review): the drain expired with the pipes still open — output may be
      // missing, so this is NOT a clean exit. Reported as a timeout, never as success.
      if (incomplete && !cancelled) {
        return { stdout, stderr: stderr + '\n[foreman] output incomplete: a process still held the output pipes ' + EXIT_DRAIN_MS + ' ms after the command exited', timedOut: true, exitCode: -1, truncated: true, stdoutTruncated: true, stderrTruncated }
      }
      if (cancelled) return { stdout, stderr, timedOut: false, cancelled: true, exitCode: -1, truncated, stdoutTruncated, stderrTruncated }
      if (timedOut) return { stdout, stderr, timedOut: true, exitCode: -1, truncated, stdoutTruncated, stderrTruncated }
      return { stdout, stderr, timedOut: false, exitCode: code ?? 1, truncated, stdoutTruncated, stderrTruncated }
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ stdout, stderr: err.message, timedOut: false, exitCode: -1, truncated: false })
    })
    // A grandchild that inherited the pipes can keep 'close' from ever firing; resolve a bounded
    // time after the child itself exits so a leaked pipe cannot hang the caller.
    child.on('exit', (code: number | null) => {
      exitCode = code
      drainTimer = setTimeout(() => { stop(); finish(outcome(exitCode, true)) }, EXIT_DRAIN_MS)
    })
    child.on('close', (code: number | null) => {
      finish(outcome(code ?? exitCode))
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
const PS1_EXT = '.ps1'

/**
 * Pick a Windows spawn plan from which/where candidates.
 * Prefers native binaries, then .cmd/.bat via cmd.exe, then .ps1 via powershell.exe.
 */
export function windowsSpawnPlan(candidates: string[]): ResolveResult {
  const natives: string[] = []
  const shims: string[] = []
  const scripts: string[] = []

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase()
    if (NATIVE_EXTS.has(ext)) natives.push(candidate)
    else if (SHIM_EXTS.has(ext)) shims.push(candidate)
    else if (ext === PS1_EXT) scripts.push(candidate)
  }

  if (natives.length > 0) {
    return { ok: true, plan: { command: natives[0], args: [] } }
  }

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  if (shims.length > 0) {
    const comspec = path.join(systemRoot, 'System32', 'cmd.exe')
    return { ok: true, plan: { command: comspec, args: ['/d', '/s', '/c', shims[0]] } }
  }

  if (scripts.length > 0) {
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return {
      ok: true,
      plan: { command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scripts[0]] },
    }
  }

  return { ok: false, reason: 'resolved but no executable candidate found' }
}

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
 * On Windows: prefers native .exe/.com; wraps .cmd/.bat via cmd.exe /d /s /c;
 * wraps .ps1 via powershell.exe -File.
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

  const plan = windowsSpawnPlan(candidates)
  if (!plan.ok) {
    return { ok: false, reason: `${cli} ${plan.reason}` }
  }
  return plan
}

/** Resolve the first binary name that exists on PATH. */
export async function resolveFirst(names: readonly string[]): Promise<ResolveResult> {
  let last: ResolveResult = { ok: false, reason: `${names.join('/')} not found` }
  for (const name of names) {
    last = await resolveInvocation(name)
    if (last.ok) return last
  }
  return last
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
  controls?: SpawnControls,
): Promise<ExternalCliResult> {
  return spawnCollect(command, args, { stdin: stdinData, timeoutMs, stdoutBudget: MAX_OUTPUT, env, signal: controls?.signal, onTick: controls?.onTick })
}
