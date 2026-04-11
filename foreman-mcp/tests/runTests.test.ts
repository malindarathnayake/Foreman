import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { runTests, DEFAULT_ALLOWED_RUNNERS } from '../src/tools/runTests.js'

describe('runTests', () => {
  describe('allowlist enforcement', () => {
    const savedEnv = process.env.FOREMAN_TEST_ALLOWLIST

    beforeAll(() => {
      delete process.env.FOREMAN_TEST_ALLOWLIST
    })

    afterAll(() => {
      if (savedEnv !== undefined) {
        process.env.FOREMAN_TEST_ALLOWLIST = savedEnv
      }
    })

    test('runner not in allowlist is rejected', async () => {
      const result = await runTests('curl', ['evil.com'])
      expect(result).toContain('error: runner not in allowlist')
      expect(result).toContain('curl')
    })

    test('node is not in default allowlist', async () => {
      const result = await runTests('node', ['-e', 'process.exit(0)'])
      expect(result).toContain('error: runner not in allowlist')
      expect(result).toContain('node')
    })

    test('default runners are correct', () => {
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('npm')
      expect(DEFAULT_ALLOWED_RUNNERS).not.toContain('npx')
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('pytest')
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('go')
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('cargo')
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('dotnet')
      expect(DEFAULT_ALLOWED_RUNNERS).toContain('make')
    })

    test('npx denied from env entries (case-insensitive)', async () => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'npx,NPX,Npx'
      const result1 = await runTests('npx', [])
      expect(result1).toContain('error: runner not in allowlist')
      const result2 = await runTests('NPX', [])
      expect(result2).toContain('error: runner not in allowlist')
      const result3 = await runTests('Npx', [])
      expect(result3).toContain('error: runner not in allowlist')
      delete process.env.FOREMAN_TEST_ALLOWLIST
    })

    test('regex filter blocks path traversal and shell metacharacters', async () => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'bash,../../evil,curl'
      const result = await runTests('../../evil', [])
      expect(result).toContain('error: runner not in allowlist')
      // bash and curl survive regex
      const bashResult = await runTests('bash', [])
      expect(bashResult).not.toContain('error: runner not in allowlist')
      delete process.env.FOREMAN_TEST_ALLOWLIST
    })

    test('regex filter drops entries with invalid characters', async () => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'valid-runner,in.valid;chars'
      const result = await runTests('in.valid;chars', [])
      expect(result).toContain('error: runner not in allowlist')
      delete process.env.FOREMAN_TEST_ALLOWLIST
    })
  })

  describe('execution', () => {
    beforeAll(() => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'node'
    })

    afterAll(() => {
      delete process.env.FOREMAN_TEST_ALLOWLIST
    })

    test('allowed runner passes (exit 0)', async () => {
      const result = await runTests('node', ['-e', 'process.exit(0)'])
      expect(result).toContain('exit_code: 0')
      expect(result).toContain('passed: true')
      expect(result).toContain('timed_out: false')
    })

    test('failed test exit code (exit 1)', async () => {
      const result = await runTests('node', ['-e', 'process.exit(1)'])
      expect(result).toContain('exit_code: 1')
      expect(result).toContain('passed: false')
    })

    test('specific exit code (exit 42)', async () => {
      const result = await runTests('node', ['-e', 'process.exit(42)'])
      expect(result).toContain('exit_code: 42')
      expect(result).toContain('passed: false')
    })

    test('stdout truncation', async () => {
      const result = await runTests('node', ['-e', 'process.stdout.write("x".repeat(20000))'], undefined, 100)
      expect(result).toContain('truncated: true')
      expect(result).toContain('...(truncated)')
    })

    test('stderr truncation', async () => {
      const result = await runTests('node', ['-e', 'process.stderr.write("y".repeat(20000))'], undefined, 100)
      // The STDERR section should contain truncated marker
      const stderrSection = result.split('\nSTDERR\n')[1] ?? ''
      expect(stderrSection).toContain('...(truncated)')
      expect(result).toContain('truncated: true')
    })

    test('tail preservation', async () => {
      const result = await runTests(
        'node',
        ['-e', 'process.stdout.write("a".repeat(20000) + "TAIL_MARKER")'],
        undefined,
        200,
      )
      expect(result).toContain('TAIL_MARKER')
    })

    test('no truncation when under limit', async () => {
      const result = await runTests('node', ['-e', 'process.stdout.write("z".repeat(50))'], undefined, 8000)
      expect(result).toContain('truncated: false')
    })

    test('timeout', async () => {
      const result = await runTests('node', ['-e', 'setTimeout(() => {}, 60000)'], 500)
      expect(result).toContain('timed_out: true')
      expect(result).toContain('exit_code: -1')
      expect(result).toContain('passed: false')
    }, 10000)

    test('TOON format structure', async () => {
      const result = await runTests('node', ['-e', 'process.exit(0)'])
      expect(result).toContain('exit_code:')
      expect(result).toContain('passed:')
      expect(result).toContain('timed_out:')
      expect(result).toContain('truncated:')
      expect(result).toContain('STDOUT')
      expect(result).toContain('STDERR')
    })

    test('custom allowlist via env accepts unknown runner (ENOENT not allowlist error)', async () => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'node,custom_test_runner'
      const result = await runTests('custom_test_runner', [])
      // Should NOT be rejected by allowlist (no allowlist error)
      expect(result).not.toContain('error: runner not in allowlist')
      // Restore
      process.env.FOREMAN_TEST_ALLOWLIST = 'node'
    })

    test('hard memory cap kills process exceeding buffer limit', async () => {
      // maxOutputChars=100, so hardCap=400
      // Process writes more than 400 chars to stdout
      const result = await runTests('node', ['-e', 'process.stdout.write("x".repeat(1000))'], undefined, 100)
      expect(result).toContain('truncated: true')
      expect(result).toContain('exit_code: -1')
      expect(result).toContain('passed: false')
      expect(result).toContain('timed_out: false')
    }, 10000)

    test('runner is resolved to absolute path via which', async () => {
      // 'node' is always available and resolvable
      const result = await runTests('node', ['-e', 'console.log("resolved")'])
      expect(result).toContain('exit_code: 0')
      expect(result).toContain('passed: true')
      expect(result).toContain('resolved')
    })

    test('nonexistent runner on allowlist returns runner not found', async () => {
      process.env.FOREMAN_TEST_ALLOWLIST = 'node,nonexistent_runner_xyz'
      const result = await runTests('nonexistent_runner_xyz', [])
      expect(result).toContain('error: runner not found')
      expect(result).toContain('nonexistent_runner_xyz')
      expect(result).not.toContain('error: runner not in allowlist')
      // Restore
      process.env.FOREMAN_TEST_ALLOWLIST = 'node'
    })
  })
})
