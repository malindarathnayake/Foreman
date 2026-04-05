# Foreman MCP v0.0.2 - Testing Harness

## Archetype: Infrastructure Tool (MCP Server)

This version adds full skill bodies to the MCP server. Testing focuses on:
- Skill resource discovery (all 3 skills listed)
- Skill content integrity (frontmatter, key directives, deliberation protocol)
- Backward compatibility (existing 73+ tool/library tests still pass)

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

---

## Test Tiers

### Tier 1: Existing Unit Tests (UNCHANGED from v0.0.1)

| Test File | What It Tests |
|-----------|---------------|
| `tests/toon.test.ts` | TOON key/value and table serialization |
| `tests/progress.test.ts` | Truncation algorithm, status computation |
| `tests/ledger.test.ts` | Mutex serialization, corruption recovery |
| `tests/externalCli.test.ts` | Timeout, stdin redirect, ENOENT |
| `tests/tools.test.ts` | Read-only tool output format |
| `tests/writeTools.test.ts` | Write tool input validation |

**Run:** `npx vitest run tests/toon.test.ts tests/progress.test.ts tests/ledger.test.ts tests/externalCli.test.ts tests/tools.test.ts tests/writeTools.test.ts`

These tests must pass unchanged. Do NOT modify them.

### Tier 2: Integration Tests (MODIFIED for v0.0.2)

| Test File | What It Tests |
|-----------|---------------|
| `tests/integration.test.ts` | Skill discovery, content integrity, tool round-trips |

**Changes from v0.0.1:**
- Skill resource list: 3 skills (was 2)
- Skill URIs: `design-partner`, `spec-generator`, `implementor` (was `project-planner`, `implementor`)
- Content assertions: updated for v0.0.2 frontmatter, deliberation protocol, MCP tool references
- bundle_status: version 0.0.2 (was 0.0.1)

**Run:** `npx vitest run tests/integration.test.ts`

---

## Key Test Scenarios (v0.0.2 additions)

### Skill Discovery (3 resources)
```typescript
const result = await client.listResources()
const uris = result.resources.map(r => r.uri)
expect(uris).toContain("skill://foreman/design-partner")
expect(uris).toContain("skill://foreman/spec-generator")
expect(uris).toContain("skill://foreman/implementor")
expect(uris).toHaveLength(3)
```

### Skill Content Integrity
```typescript
// design-partner: has deliberation protocol
const dp = await client.readResource({ uri: "skill://foreman/design-partner" })
expect(dp.contents[0].text).toContain("mcp__foreman__capability_check")
expect(dp.contents[0].text).toContain("version: 0.0.2")

// spec-generator: has ledger prohibition + grounding checks
const sg = await client.readResource({ uri: "skill://foreman/spec-generator" })
expect(sg.contents[0].text).toContain("mcp__foreman__write_ledger")
expect(sg.contents[0].text).toContain("version: 0.0.2")

// implementor: has disableSlashCommand + MCP tool refs
const impl = await client.readResource({ uri: "skill://foreman/implementor" })
expect(impl.contents[0].text).toContain("disableSlashCommand: true")
expect(impl.contents[0].text).toContain("mcp__foreman__read_ledger")
```

---

## Common Failures and Fixes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `skill://foreman/project-planner` still listed | Old file not deleted | Delete `src/skills/project-planner.md` |
| Resource count is 2 instead of 3 | Missing skill file | Check `ls src/skills/` — should have 3 `.md` files |
| bundle_status returns 0.0.1 | package.json not updated | Change version to 0.0.2 |
| Content assertion fails on "version: 0.0.2" | Frontmatter has old version | Update skill frontmatter |
| Integration test hangs | Server not closing | Ensure `afterEach` calls `server.close()` |

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
