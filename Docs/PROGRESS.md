# Progress

## foundation

- [ ] 1a: Types and constants

## foundation

- [x] 1a-types: All phases complete, 27 tests passing (2026-04-05T03:47:00Z)

## Foundation


## Core Logic


## Commands


## Wiring


## Core Infrastructure

- [ ] 1a-externalcli-cap: Add MAX_OUTPUT cap and truncated field to externalCli
- [ ] 1b-run-tests: Create runTests tool handler with bounded output

## Integration & Protocol

- [ ] 2a-register-version: Register run_tests tool in server.ts, bump version to 0.0.5, add changelog entry
- [ ] 2b-protocol-update: Update implementor.md step 6.2 and checkpoint to use run_tests

## Security Hardening

- [ ] 3a-input-caps: Add .max(10000) to all string fields in write schemas (INJ-004, EXH-002)
- [ ] 3b-rej-cap-skill-error: Cap rej[] at 20 FIFO + generic skill loader error (EXH-002, DIS-001)
- [ ] 3c-cli-path-resolve: Resolve codex/gemini to absolute paths via which (INJ-005)
- [ ] 3d-changelog: Update changelog entry to include security hardening items

## Schema Caps + Deferred Items

- [ ] 1a-types-schemas: NormalizeReviewInputSchema + ReadLedgerInputSchema caps in types.ts
- [ ] 1b-server-inline-caps: Cap all inline schemas in server.ts, import NormalizeReviewInputSchema
- [ ] 1c-error-log-fifo: error_log FIFO cap at 20 in progress.ts
- [ ] 1d-path-isabsolute: path.isAbsolute() check in capabilityCheck.ts resolveCliPath

## runTests Hardening

- [ ] 2a-memory-cap: Hard memory cap (4x maxOutputChars) in runTests.ts
- [ ] 2b-runner-path-resolution: Runner PATH resolution via which + isAbsolute in runTests.ts

## Integration + Version Bump

- [ ] 3a-version-changelog: Version bump 0.0.5->0.0.6, changelog entry
- [ ] 3b-test-updates: Version assertions, new tests for FIFO, memory cap, PATH resolution, schema caps

## Foundation

- [x] 1a-types-validate: 31 tests passing, accepted first pass (2026-04-10T22:05:00Z)

## Foundation (types + storage + validation)

- [x] 1a-types-validate: 16 tests pass. types.ts + validate.ts created. (2026-04-11T17:31:00Z)
- [x] 1b-storage: 8 tests pass. storage.ts created. Phase 1 checkpoint 24/24. (2026-04-11T17:33:00Z)

## Commands (add, list, summary, export)


## CLI Entry + Integration


