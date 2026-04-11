import { spawn } from 'child_process'
import { runExternalCli, RESOLVE_CMD, parseResolutionOutput, isAbsolutePath } from '../lib/externalCli.js'
import path from 'path'

export const DEFAULT_ALLOWED_RUNNERS = ["npm", "pytest", "go", "cargo", "dotnet", "make"]
const BUFFER_CAP_MULTIPLIER = 4
const resolvedRunners = new Map<string, string>()

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

async function resolveRunner(runner: string): Promise<string | null> {
  if (resolvedRunners.has(runner)) return resolvedRunners.get(runner)!
  const result = await runExternalCli(RESOLVE_CMD, [runner], 3000)
  if (result.exitCode === 0 && result.stdout.trim()) {
    const candidates = parseResolutionOutput(result.stdout)
    if (candidates.length === 0) return null
    const absPath = candidates[0]
    // Reject .cmd/.bat on Windows — user-controlled args through cmd.exe /c is unsafe
    if (process.platform === 'win32' && CMD_EXTS.has(path.extname(absPath).toLowerCase())) {
      return null
    }
    resolvedRunners.set(runner, absPath)
    return absPath
  }
  return null
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

  const resolvedPath = await resolveRunner(runner)
  if (!resolvedPath) {
    return `error: runner not found\nrunner: ${runner}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
  }

  return new Promise((resolve) => {
    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    let timedOut = false

    const child = spawn(resolvedPath, args, {
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
