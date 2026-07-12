import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { runExternalCli, RESOLVE_CMD, parseResolutionOutput, type SpawnPlan } from '../lib/externalCli.js'
import path from 'path'

export const DEFAULT_ALLOWED_RUNNERS = ["npm", "pytest", "go", "cargo", "dotnet", "make"]
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

async function resolveRunner(runner: string): Promise<RunnerResolution> {
  const cached = resolvedRunners.get(runner)
  if (cached) return { ok: true, plan: cached }
  const result = await runExternalCli(RESOLVE_CMD, [runner], 3000)
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { ok: false, error: `runner not found\nrunner: ${runner}` }
  }

  const resolution = planFromCandidates(
    runner,
    parseResolutionOutput(result.stdout),
    process.platform,
    existsSync,
  )
  if (resolution.ok) {
    resolvedRunners.set(runner, resolution.plan)
  }
  return resolution
}

function truncate(buf: string, max: number): { text: string; wasTruncated: boolean } {
  if (buf.length <= max) return { text: buf, wasTruncated: false }
  return { text: '...(truncated)\n' + buf.slice(-max), wasTruncated: true }
}

export async function runTests(
  runner: string,
  args: string[],
  timeoutMs: number = 60000,
  maxOutputChars: number = 8000,
): Promise<string> {
  const allowedRunners = getAllowedRunners()
  if (!allowedRunners.includes(runner)) {
    return Promise.resolve(
      `error: runner not in allowlist\nrunner: ${runner}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
    )
  }

  const resolution = await resolveRunner(runner)
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
          const { text: stdoutText, wasTruncated: stdoutTruncated } = truncate(stdoutBuf, maxOutputChars)
          const { text: stderrText, wasTruncated: stderrTruncated } = truncate(stderrBuf, maxOutputChars)
          resolve(
            `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n\nSTDOUT\n${stdoutText}\n\nSTDERR\n${stderrText}`
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
          const { text: stdoutText, wasTruncated: stdoutTruncated } = truncate(stdoutBuf, maxOutputChars)
          const { text: stderrText, wasTruncated: stderrTruncated } = truncate(stderrBuf, maxOutputChars)
          resolve(
            `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n\nSTDOUT\n${stdoutText}\n\nSTDERR\n${stderrText}`
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

      const { text: stdoutText, wasTruncated: stdoutTruncated } = truncate(stdoutBuf, maxOutputChars)
      const { text: stderrText, wasTruncated: stderrTruncated } = truncate(stderrBuf, maxOutputChars)
      const truncated = stdoutTruncated || stderrTruncated

      const exitCode = timedOut ? -1 : (code ?? 1)
      const passed = !timedOut && exitCode === 0

      const output =
        `exit_code: ${exitCode}\n` +
        `passed: ${passed}\n` +
        `timed_out: ${timedOut}\n` +
        `truncated: ${truncated}\n` +
        `\nSTDOUT\n` +
        stdoutText +
        `\n\nSTDERR\n` +
        stderrText

      resolve(output)
    })
  })
}
