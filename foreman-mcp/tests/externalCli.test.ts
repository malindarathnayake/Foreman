import { describe, test, expect } from 'vitest'
import { runExternalCli, MAX_OUTPUT } from '../src/lib/externalCli.js'

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
