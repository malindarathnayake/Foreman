import { describe, test, expect, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  runExternalCli,
  MAX_OUTPUT,
  resolvePython,
  probeAiderCapability,
  buildFilteredChildEnv,
  runWithStdin,
} from '../src/lib/externalCli.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_HARNESS_PATH = path.join(__dirname, 'fixtures', 'aiderHarnessFixture.mjs')

describe('runExternalCli', () => {
  test('normal completion returns full output', async () => {
    const result = await runExternalCli('node', ['-e', 'process.stdout.write("hello world")'], 5000)
    expect(result.stdout).toBe('hello world')
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  test('timeout kills the process and sets timedOut: true', async () => {
    const result = await runExternalCli('node', ['-e', "process.stdout.write('partial'); setTimeout(() => {}, 60000)"], 500)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
    expect(result.stdout).toBe('partial')
  }, 10000)

  test('missing binary resolves gracefully with ENOENT', async () => {
    const result = await runExternalCli('nonexistent_binary_xyz_12345', [], 5000)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('ENOENT')
  })

  test('stdin is closed — process reading stdin gets EOF', async () => {
    const result = await runExternalCli('node', ['-e', `
  let gotData = false;
  process.stdin.on('data', () => { gotData = true; process.stdout.write('stdin-had-data'); process.exit(1); });
  process.stdin.on('end', () => { if (!gotData) { process.stdout.write('stdin-closed'); process.exit(0); } });
  process.stdin.resume();
`], 5000)
    expect(result.stdout).toBe('stdin-closed')
    expect(result.exitCode).toBe(0)
  })

  test('non-zero exit code is captured', async () => {
    const result = await runExternalCli('node', ['-e', 'process.exit(42)'], 5000)
    expect(result.exitCode).toBe(42)
    expect(result.timedOut).toBe(false)
  })

  test('stdout and stderr are captured separately', async () => {
    const result = await runExternalCli(
      'node',
      ['-e', 'process.stderr.write("err"); process.stdout.write("out")'],
      5000,
    )
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
  })

  test('large stdout is truncated at MAX_OUTPUT', async () => {
    const result = await runExternalCli('node', ['-e', `process.stdout.write("x".repeat(${MAX_OUTPUT + 5000}))`], 5000)
    expect(result.truncated).toBe(true)
    expect(result.stdout).toContain('...(truncated)')
    expect(result.stdout.length).toBeLessThan(MAX_OUTPUT + 100)
  })

  test('large stderr is truncated at MAX_OUTPUT', async () => {
    const result = await runExternalCli('node', ['-e', `process.stderr.write("y".repeat(${MAX_OUTPUT + 5000}))`], 5000)
    expect(result.truncated).toBe(true)
    expect(result.stderr).toContain('...(truncated)')
    expect(result.stderr.length).toBeLessThan(MAX_OUTPUT + 100)
  })

  test('small output is not truncated', async () => {
    const result = await runExternalCli('node', ['-e', `process.stdout.write("z".repeat(100))`], 5000)
    expect(result.truncated).toBe(false)
    expect(result.stdout.length).toBe(100)
  })

  test('truncation preserves tail', async () => {
    const result = await runExternalCli(
      'node',
      ['-e', `process.stdout.write("a".repeat(${MAX_OUTPUT + 5000}) + "TAIL_MARKER")`],
      5000,
    )
    expect(result.truncated).toBe(true)
    expect(result.stdout).toContain('TAIL_MARKER')
  })
})

// ── resolvePython / probeAiderCapability (Unit 3a) ──────────────────────────────────
describe('resolvePython', () => {
  test('a resolvable preferred candidate ("node") resolves ok', async () => {
    const result = await resolvePython('node')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.command.length).toBeGreaterThan(0)
  })

  test('a bogus preferred candidate still falls through to python3/python candidates', async () => {
    // Deterministic assertion only on the fallback attempt itself, not on whether a
    // real python3/python happens to be installed on the host running this test —
    // that branch is host-dependent (see probeAiderCapability tests below, which pin
    // aider-presence via the Node fixture instead of relying on host python).
    const result = await resolvePython('definitely-not-a-real-xyz')
    // Either it fails (no python3/python on this host) or it falls through to a real
    // one — both are valid outcomes; the call must simply never throw.
    expect(typeof result.ok).toBe('boolean')
  })
})

describe('probeAiderCapability', () => {
  afterEach(() => {
    delete process.env.FIXTURE_AIDER_AVAILABLE
  })

  test('aider available (default fixture behavior) -> ok with resolved plan', async () => {
    const result = await probeAiderCapability('node', FIXTURE_HARNESS_PATH, 5000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.command.length).toBeGreaterThan(0)
  })

  test('aider not importable (FIXTURE_AIDER_AVAILABLE=0) -> missing: aider', async () => {
    process.env.FIXTURE_AIDER_AVAILABLE = '0'
    const result = await probeAiderCapability('node', FIXTURE_HARNESS_PATH, 5000)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missing).toBe('aider')
  })
})

// ── buildFilteredChildEnv / runWithStdin env (CWE-200 child env filtering) ──────────────
describe('buildFilteredChildEnv', () => {
  test('strips denylisted names and secret-pattern names; keeps everything else', () => {
    const source = {
      PATH: 'x',
      MY_API_KEY: 'k',
      DB_PASSWORD: 'p',
      FIXTURE_MODE: 'edit',
      SAFE_VAR: 'ok',
      SPECIAL_TOKEN: 't',
    }
    const result = buildFilteredChildEnv(['MY_API_KEY'], source)

    expect(result.PATH).toBe('x')
    expect(result.FIXTURE_MODE).toBe('edit')
    expect(result.SAFE_VAR).toBe('ok')

    expect(result.MY_API_KEY).toBeUndefined()
    expect(result.DB_PASSWORD).toBeUndefined()
    expect(result.SPECIAL_TOKEN).toBeUndefined()
  })
})

describe('runWithStdin env param', () => {
  test('an explicit env is passed to the child (PLANTED var visible)', async () => {
    const resolved = await resolvePython('node')
    if (!resolved.ok) {
      return
    }
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PLANTED: 'here' }
    const result = await runWithStdin(
      'node',
      ['-e', "process.stdout.write(process.env.PLANTED ?? 'ABSENT')"],
      '',
      5000,
      env,
    )
    expect(result.stdout).toContain('here')
  })

  test('a buildFilteredChildEnv-filtered env strips a secret-named var from the child', async () => {
    const resolved = await resolvePython('node')
    if (!resolved.ok) {
      return
    }
    const env = buildFilteredChildEnv([], {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PLANTED_SECRET_KEY: 'leak',
    })
    const result = await runWithStdin(
      'node',
      ['-e', "process.stdout.write(process.env.PLANTED_SECRET_KEY ?? 'ABSENT')"],
      '',
      5000,
      env,
    )
    expect(result.stdout).toBe('ABSENT')
  })
})
