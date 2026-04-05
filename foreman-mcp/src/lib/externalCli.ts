import { spawn } from 'child_process'

export interface ExternalCliResult {
  stdout: string
  stderr: string
  timedOut: boolean
  exitCode: number
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

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Close stdin immediately to signal EOF to the child process
    child.stdin.end()

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
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
      resolve({ stdout, stderr: err.message, timedOut: false, exitCode: -1 })
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (settled) return
      settled = true
      if (timedOut) {
        resolve({ stdout, stderr, timedOut: true, exitCode: -1 })
      } else {
        resolve({ stdout, stderr, timedOut: false, exitCode: code ?? 1 })
      }
    })
  })
}
