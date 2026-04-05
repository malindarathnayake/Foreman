# Foreman MCP - Testing Harness

## Archetype: Infrastructure Tool (MCP Server)

This project is an MCP server that exposes tools and skill resources. Testing focuses on:
- Serialization correctness (mutex, atomic writes)
- Bounded output (truncation, TOON formatting)
- External process management (timeout, stdin, fallback)
- MCP protocol compliance (tool schemas, resource URIs)

---

## Environment Setup

### Prerequisites
- Node.js >= 22 (via nvm)
- npm

### Install
```bash
cd foreman-mcp
npm install
```

### Run All Tests
```bash
cd foreman-mcp && npx vitest run
```

### Run Tests in Watch Mode
```bash
cd foreman-mcp && npx vitest
```

---

## Test Tiers

### Tier 1: Unit Tests (No I/O)

| Test File | What It Tests | Dependencies |
|-----------|---------------|-------------|
| `tests/progress.test.ts` | Truncation algorithm, status computation | None (pure functions) |
| `tests/toon.test.ts` | TOON key/value and table serialization | None (pure functions) |

**Run:** `npx vitest run tests/progress.test.ts tests/toon.test.ts`

### Tier 2: Filesystem Integration Tests

| Test File | What It Tests | Dependencies |
|-----------|---------------|-------------|
| `tests/ledger.test.ts` | Mutex serialization, corruption recovery, concurrent writes | Real filesystem (tmpdir) |
| `tests/externalCli.test.ts` | Timeout, stdin redirect, ENOENT handling | `child_process.spawn` (mocked or real) |

**Run:** `npx vitest run tests/ledger.test.ts tests/externalCli.test.ts`

**Setup:** Tests use `vitest`'s `tmpdir` fixture for isolated filesystem. No manual cleanup needed.

### Tier 3: MCP Integration Tests

| Test File | What It Tests | Dependencies |
|-----------|---------------|-------------|
| `tests/integration.test.ts` | Full MCP round-trip: connect → call tools → verify responses | MCP SDK test client, real filesystem |

**Run:** `npx vitest run tests/integration.test.ts`

**Setup:** Uses `@modelcontextprotocol/sdk` `Client` class connected to the server via in-process stdio mock or direct function calls.

---

## Key Test Scenarios

### Ledger Mutex (Critical Path)

```typescript
test('concurrent writes are serialized', async () => {
  // Launch 10 write_ledger calls simultaneously
  // Each increments a counter in the ledger
  // After all resolve, counter should be 10 (not less due to lost updates)
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writeLedger(ledgerPath, {
        operation: 'set_unit_status',
        phase: 'p1',
        unit_id: `u${i}`,
        data: { s: 'done', v: 'pass' }
      })
    )
  )
  const ledger = await readLedger(ledgerPath)
  expect(Object.keys(ledger.phases.p1.units)).toHaveLength(10)
})
```

### External CLI Timeout (Critical Path)

```typescript
test('process killed after timeout', async () => {
  // Spawn a process that sleeps for 60s
  const result = await runExternalReviewer(
    'sleep', ['60'],
    '', // no prompt needed
    1000, // 1s timeout for test speed
  )
  expect(result.timedOut).toBe(true)
  expect(result.exitCode).toBe(-1)
})
```

### Progress Truncation

```typescript
test('truncates to last N completed', () => {
  const progress = makeProgressWithNUnits(50, 5) // 50 complete, 5 incomplete
  const view = truncateProgress(progress, 10)
  expect(view.completed).toHaveLength(10)
  expect(view.incomplete).toHaveLength(5)
  // Most recent completed units first
  expect(view.completed[0].id).toBe('u50')
})
```

---

## Mock Boundaries

| Dependency | Tier 1-2 | Tier 3 |
|------------|----------|--------|
| Filesystem | Real (tmpdir) | Real (tmpdir) |
| child_process | Mocked spawn | Mocked spawn |
| MCP SDK | Not used | Real test client |
| External CLIs | Not used | Not used (mocked via spawn) |

---

## What NOT to Test

- Claude Code's MCP client reconnection logic (upstream concern)
- `proper-lockfile` internals (not used; we use promise-chain mutex)
- Actual Codex/Gemini CLI output quality (opaque external systems)
- MCP protocol wire format (SDK handles this)

---

## Common Failures and Fixes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `ENOENT` in ledger tests | tmpdir not created | Ensure `beforeEach` creates test directory |
| Flaky concurrent test | Mutex not actually serializing | Check promise-chain wiring — `prev.then(fn)` must chain correctly |
| Integration test hangs | Server not closing transport | Ensure `afterAll` calls `server.close()` |
| Timeout test too slow | Using real `sleep` command | Use 100-500ms timeouts in tests, not 120s |

---

## CI Integration

```yaml
# GitHub Actions snippet
- name: Test Foreman MCP
  run: |
    cd foreman-mcp
    npm ci
    npx vitest run --reporter=verbose
```
