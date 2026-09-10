import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extractDirective, preflightCheck } from "../src/tools/preflightCheck.js"
import { findPreflight, briefHash, preflightPathFor } from "../src/lib/preflight.js"

const SPEC = `# Spec

## 6. Implementation Order

### Phase 11 — GraphQL

#### p11.1 — GraphQL client and classifier
- Files: internal/cfsource/graphql/client.go, internal/cfsource/graphql/classify.go
- Retry on transport failure and 429/5xx only using the §7.4 policy (2 retries, 500 ms base, full jitter); never retry a 4xx.
- The classifier keeps four end states apart: \`authz\`, \`forbidden\`, \`empty\`, \`unknown_field\`.
- Raise an ops finding naming the missing permission on a 403, following \`TestCFAPINoVectorSkips\` in cfapi_test.go.
- Guard the cfapi read failure: a nil client returns \`ErrClientUnavailable\`, never a panic (see internal/cfsource/cfapi/client.go:12).
Test: go test ./internal/cfsource/graphql/...

#### p11.2 — settings document
- Files: internal/cfsource/graphql/settings.go
- Runs the settings document verbatim.

## 7. Policies
### 7.4 Retry
2 retries, 500 ms base, full jitter.
`

let root: string
let preflightFile: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-pfc-"))
  preflightFile = preflightPathFor(path.join(root, "Docs", "ledger.json"))
  await fs.mkdir(path.join(root, "Docs"), { recursive: true })
  await fs.mkdir(path.join(root, "internal", "cfsource", "cfapi"), { recursive: true })
  await fs.writeFile(path.join(root, "Docs", "spec.md"), SPEC)
  await fs.writeFile(path.join(root, "internal", "cfsource", "cfapi", "client.go"), "package cfapi\n\nimport \"errors\"\n\nvar ErrClientUnavailable = errors.New(\"unavailable\")\n\ntype Kind int\n\nfunc dispatch(k Kind) {\n\tswitch k {\n\tdefault:\n\t}\n}\n")
  await fs.writeFile(path.join(root, "internal", "cfsource", "cfapi", "cfapi_test.go"), "package cfapi\n\nfunc TestCFAPINoVectorSkips(t *testing.T) {}\n")
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("extractDirective", () => {
  it("returns the unit's block from its heading to the next unit heading", () => {
    const d = extractDirective(SPEC, "p11.1")!
    expect(d.startsWith("#### p11.1")).toBe(true)
    expect(d).toContain("ErrClientUnavailable")
    expect(d).not.toContain("p11.2")
    expect(d).not.toContain("## 7. Policies")
    expect(extractDirective(SPEC, "p11.2")).toContain("settings document verbatim")
    expect(extractDirective(SPEC, "p11.9")).toBeNull()
    // p11.1 must not match p11.10
    expect(extractDirective(SPEC.replace("p11.2", "p11.10"), "p11.1")).not.toContain("p11.10")
  })
})

describe("preflight_check", () => {
  const base = {
    phase: "p11", unit_id: "p11.1", repo_root: "", spec_path: "Docs/spec.md",
    files: ["internal/cfsource/graphql/client.go", "internal/cfsource/graphql/classify.go"],
  }
  const goodBrief = `Implement client.go and classify.go. Retry on transport failure and 429/5xx only with 2 retries, 500 ms base and full jitter; never retry a 4xx.
Keep the four classifier states apart: \`authz\`, \`forbidden\`, \`empty\`, \`unknown_field\`.
Raise an ops finding naming the missing permission on a 403, following \`TestCFAPINoVectorSkips\` in \`internal/cfsource/cfapi/cfapi_test.go\`.
Guard the nil client with \`ErrClientUnavailable\` (\`internal/cfsource/cfapi/client.go:5\`).`

  it("passes a grounded brief, writes a passing record, and lists what the brief still does not echo", async () => {
    const text = await preflightCheck({ ...base, repo_root: root, brief: goodBrief, symbols: ["ErrClientUnavailable", "unknown_field"] }, preflightFile)
    expect(text).toContain("status: pass")
    expect(text).toContain("symbols_missing_from_spec: none")
    expect(text).toContain("dead_citations: 0")
    expect(text).toContain("next: Record the delegation with preflight: { receipt: brief_hash")
    const rec = await findPreflight(preflightFile, briefHash(goodBrief))
    expect(rec).toMatchObject({ status: "pass", unit_id: "p11.1", symbols: 2, dead_citations: 0 })
  })

  it("fails on a symbol the spec does not contain and on a dead citation, and records the failure", async () => {
    const badBrief = goodBrief + "\nAlso follow TestDoesNotExist and see `internal/cfsource/nowhere.go:3` and `internal/cfsource/cfapi/client.go:400`."
    const text = await preflightCheck({ ...base, repo_root: root, brief: badBrief, symbols: ["ErrClientUnavailable", "NotInTheSpec"] }, preflightFile)
    expect(text).toContain("status: fail")
    expect(text).toContain("symbols_missing_from_spec: NotInTheSpec")
    expect(text).toMatch(/dead_citations: [1-9]/)
    expect(text).toContain("DEAD CITATIONS (refused)")
    expect(text).toContain("nowhere.go")
    expect(text).toContain("TestDoesNotExist")
    expect(text).toContain("drifted_citations: 1")
    expect(await findPreflight(preflightFile, briefHash(badBrief))).toBeNull()
  })

  it("reports directive omissions and out-of-set references as advisories without failing", async () => {
    const thinBrief = "Implement client.go and classify.go with retries on transport failure and 429/5xx; never retry a 4xx. Keep `authz`, `forbidden`, `empty`, `unknown_field` apart."
    const text = await preflightCheck({ ...base, repo_root: root, brief: thinBrief, symbols: ["unknown_field"], type_names: ["Kind"], introduces: ["KindGraphQL"] }, preflightFile)
    expect(text).toContain("status: pass")
    expect(text).toContain("DIRECTIVE SENTENCES WITH NO ECHO IN THE BRIEF")
    expect(text).toContain("ops finding")
    expect(text).toContain("ErrClientUnavailable")
    expect(text).toContain("FILES OUTSIDE THE DECLARED SET")
    expect(text).toMatch(/internal\/cfsource\/cfapi\/client\.go\s*\|\s*Kind\s*\|\s*true\s*\|\s*true/)
  })

  it("names the missing directive and accepts directive text directly", async () => {
    const text = await preflightCheck({ ...base, repo_root: root, unit_id: "p99.9", brief: goodBrief, symbols: ["unknown_field"] }, preflightFile)
    expect(text).toContain("directive_not_found")
    const direct = await preflightCheck({ ...base, repo_root: root, unit_id: "p99.9", brief: goodBrief, symbols: ["unknown_field"], directive: "- Keep `unknown_field` apart." }, preflightFile)
    expect(direct).toContain("status: pass")
  })
})
