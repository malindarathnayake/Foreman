import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { renderOracle, runOracle, VerifyOracleInputSchema } from "../src/tools/verifyOracle.js"

let root: string
const SRC = "package guard\n\nfunc Check(n int) bool {\n\tif n < 0 {\n\t\treturn false\n\t}\n\treturn true\n}\n"
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-oracle-"))
  await fs.mkdir(path.join(root, "internal"), { recursive: true })
  await fs.writeFile(path.join(root, "internal", "guard.go"), SRC)
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** A fake run_tests that reads the mutated file and "fails" when the control is gone. */
const fakeRunner = (behaviour: "observes" | "blind" | "error" | "timeout" | "red") => async (_r: string, _a: string[], _t: number, cwd: string): Promise<string> => {
  expect(cwd).toBe(root)
  const text = await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")
  if (behaviour === "error") return "error: runner not in allowlist\nrunner: bogus"
  if (behaviour === "red") return "exit_code: 2\npassed: false\ntimed_out: false\nSTDOUT\nmake: *** No rule to make target"
  const controlPresent = text.includes("if n < 0")
  if (behaviour === "timeout" && !controlPresent) return "exit_code: -1\npassed: false\ntimed_out: true\nSTDOUT\n"
  const passed = behaviour === "blind" ? true : controlPresent
  return `exit_code: ${passed ? 0 : 1}\npassed: ${passed}\ntimed_out: false\nSTDOUT\nok`
}
const input = (extra: Record<string, unknown> = {}) => VerifyOracleInputSchema.parse({
  phase: "p1", unit_id: "u1", repo_root: root,
  mutations: [{ label: "drop-negative-guard", file: "internal/guard.go", old: "if n < 0 {\n\t\treturn false\n\t}", new: "", runner: "go", args: ["test", "./internal/..."] }],
  ...extra,
})

describe("verify_oracle", () => {
  it("kills a mutation the guard test observes and restores the file byte for byte", async () => {
    const report = await runOracle(input(), fakeRunner("observes"))
    expect(report).toMatchObject({ mutations: 1, killed: 1, survivors: [], invalid: [] })
    expect(report.results[0]).toMatchObject({ outcome: "killed", exit_code: 1 })
    expect(await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")).toBe(SRC)
    expect(renderOracle(report)).toContain("verdict: oracle_holds")
  })
  it("a blind suite leaves a survivor and the report says the suite cannot observe the control", async () => {
    const report = await runOracle(input(), fakeRunner("blind"))
    expect(report.survivors).toEqual(["drop-negative-guard"])
    expect(renderOracle(report)).toContain("verdict: oracle_blind")
    expect(renderOracle(report)).toContain("cannot observe")
    expect(await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")).toBe(SRC)
  })
  it("an absent or ambiguous old text, a file outside the root, and a refused runner are invalid, never a kill", async () => {
    const report = await runOracle(input({ mutations: [
      { label: "absent", file: "internal/guard.go", old: "not here", new: "", runner: "go", args: [] },
      { label: "ambiguous", file: "internal/guard.go", old: "return", new: "", runner: "go", args: [] },
      { label: "outside", file: "../etc/passwd", old: "root", new: "", runner: "go", args: [] },
      { label: "refused", file: "internal/guard.go", old: "if n < 0 {", new: "if false {", runner: "bogus", args: [] },
    ] }), fakeRunner("error"))
    expect(report.invalid).toEqual(["absent", "ambiguous", "outside", "refused"])
    expect(report.killed).toBe(0)
    expect(report.results.map((r) => r.detail)).toEqual([
      "old text occurs 0 times; it must occur exactly once",
      "old text occurs 2 times; it must occur exactly once",
      "file is outside the repository root",
      "baseline red: error: runner not in allowlist",
    ])
    expect(renderOracle(report)).toContain("verdict: incomplete")
    expect(await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")).toBe(SRC)
  })
  it("a red baseline (a missing make target) makes every mutation under that guard invalid, never a kill", async () => {
    const report = await runOracle(input(), fakeRunner("red"))
    expect(report.results[0]).toMatchObject({ outcome: "invalid", detail: "baseline red: guard exits 2 unmutated; fix the guard before probing" })
    expect(report.killed).toBe(0)
  })
  it("a mutated run that times out is invalid, and a guard whose arguments never name the file gets a relevance hint", async () => {
    const report = await runOracle(input({ mutations: [
      { label: "drop-negative-guard", file: "internal/guard.go", old: "if n < 0 {\n\t\treturn false\n\t}", new: "", runner: "go", args: ["test", "./other/..."] },
    ] }), fakeRunner("timeout"))
    expect(report.results[0].outcome).toBe("invalid")
    expect(report.results[0].detail).toContain("timed out")
    expect(report.results[0].detail).toContain("no guard argument names this file's directory")
    const blind = await runOracle(input({ mutations: [
      { label: "drop-negative-guard", file: "internal/guard.go", old: "if n < 0 {\n\t\treturn false\n\t}", new: "", runner: "go", args: ["test", "./internal/..."] },
    ] }), fakeRunner("blind"))
    expect(blind.results[0].detail).not.toContain("hint")
  })
  it("a concurrent write during the probe is never erased: the restore refuses and names the file", async () => {
    const clobber = async (): Promise<string> => {
      await fs.writeFile(path.join(root, "internal", "guard.go"), "package guard\n// someone else wrote this mid-probe\n")
      return "exit_code: 1\npassed: false\ntimed_out: false\nSTDOUT\n"
    }
    let calls = 0
    const runner = async (r: string, a: string[], t: number, c: string) => (calls++ === 0 ? fakeRunner("observes")(r, a, t, c) : clobber())
    await expect(runOracle(input(), runner)).rejects.toThrow(/ORACLE RESTORE FAILED: internal\/guard.go .* neither the mutation nor the original; it was left untouched/)
    expect(await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")).toContain("someone else wrote this")
  })
  it("restores the file even when the runner throws, and aborts loudly if the restore does not match", async () => {
    await expect(runOracle(input(), async () => { throw new Error("runner exploded") })).rejects.toThrow("runner exploded")
    expect(await fs.readFile(path.join(root, "internal", "guard.go"), "utf-8")).toBe(SRC)
    // a runner that makes the file read-only behind the tool's back is caught by the hash check;
    // the first call is the green baseline, the second is the mutated run
    let n = 0
    const sabotage = async () => {
      if (n++ === 0) return "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok"
      await fs.chmod(path.join(root, "internal", "guard.go"), 0o444)
      return "exit_code: 1\npassed: false\ntimed_out: false\nSTDOUT\n"
    }
    await fs.chmod(path.join(root, "internal", "guard.go"), 0o644)
    const report = await runOracle(input(), sabotage).catch((e: Error) => e)
    await fs.chmod(path.join(root, "internal", "guard.go"), 0o644)
    // on platforms where chmod is honoured the restore fails loudly; elsewhere the mutation is simply killed
    if (report instanceof Error) expect(report.message).toMatch(/ORACLE RESTORE FAILED/)
    else expect(report.killed).toBe(1)
  })
})
