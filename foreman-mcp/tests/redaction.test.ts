import { describe, it, expect, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  harvestSecrets,
  registerSecret,
  scrub,
  findSecrets,
  INBOUND_MARKER_PATTERNS,
  containsRedactionMarker,
  resetForTest,
} from "../src/lib/redaction.js"
import { writeLedger } from "../src/lib/ledger.js"
import { initSession, logEvent } from "../src/lib/journal.js"
import { writeProgress } from "../src/lib/progress.js"
import { handleWriteProgress, FENCE_START, FENCE_END } from "../src/tools/writeProgress.js"

const PLANTED_KEYS = [
  "REDACTION_TEST_API_KEY",
  "REDACTION_TEST_API_KEY_2",
  "REDACTION_TEST_SECRET",
  "REDACTION_TEST_CUSTOM_REF",
  "SCRUB_4B_LEDGER_KEY",
  "SCRUB_4B_JOURNAL_KEY",
  "SCRUB_4B_PROGRESS_KEY",
  "SCRUB_4B_MARKDOWN_KEY",
]

function plant(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    process.env[name] = value
  }
}

afterEach(() => {
  for (const key of PLANTED_KEYS) {
    delete process.env[key]
  }
  resetForTest()
})

describe("harvestSecrets", () => {
  it("harvests matching names with qualifying values", () => {
    const env = {
      API_KEY: "fixture_value_0000000a",
      MY_SECRET: "fixture_value_0000000b",
      AUTH_TOKEN: "fixture_value_0000000c",
      DB_PASSWORD: "fixture_value_0000000d",
      private_key: "fixture_value_0000000e",
    }
    const harvested = harvestSecrets(env)
    expect(harvested.get("API_KEY")).toBe("fixture_value_0000000a")
    expect(harvested.get("MY_SECRET")).toBe("fixture_value_0000000b")
    expect(harvested.get("AUTH_TOKEN")).toBe("fixture_value_0000000c")
    expect(harvested.get("DB_PASSWORD")).toBe("fixture_value_0000000d")
    expect(harvested.get("private_key")).toBe("fixture_value_0000000e")
  })

  it("excludes non-matching names", () => {
    const env = { HOME: "fixture_value_0000000a", EDITOR: "fixture_value_0000000b" }
    const harvested = harvestSecrets(env)
    expect(harvested.size).toBe(0)
  })

  it("enforces the length boundary: 7 chars excluded, 8 chars included", () => {
    const env = {
      SHORT_KEY: "1234567",
      LONG_KEY: "12345678",
    }
    const harvested = harvestSecrets(env)
    expect(harvested.has("SHORT_KEY")).toBe(false)
    expect(harvested.has("LONG_KEY")).toBe(true)
  })

  it("excludes denylisted values (R11 example), case-insensitively", () => {
    const env = {
      AUTH_MODE: "disabled",
      AUTH_MODE_2: "DISABLED",
    }
    const harvested = harvestSecrets(env)
    expect(harvested.has("AUTH_MODE")).toBe(false)
    expect(harvested.has("AUTH_MODE_2")).toBe(false)
  })

  it("harvests a denylist word when it is part of a longer value", () => {
    const env = { AUTH_MODE_3: "disabled_but_longer" }
    const harvested = harvestSecrets(env)
    expect(harvested.get("AUTH_MODE_3")).toBe("disabled_but_longer")
  })

  it("excludes multi-token values (space, tab, newline)", () => {
    const env = {
      SPACE_KEY: "abcd efgh",
      TAB_KEY: "abcd\tefgh",
      NEWLINE_KEY: "abcd\nefgh",
    }
    const harvested = harvestSecrets(env)
    expect(harvested.size).toBe(0)
  })

  it("excludes undefined and empty-string values", () => {
    const env = { UNDEF_KEY: undefined, EMPTY_KEY: "" }
    const harvested = harvestSecrets(env)
    expect(harvested.size).toBe(0)
  })

  it("inserts entries in ascending NAME order", () => {
    const env = {
      ZKEY_TOKEN: "fixture_value_0000000a",
      AKEY_TOKEN: "fixture_value_0000000b",
      MKEY_TOKEN: "fixture_value_0000000c",
    }
    const harvested = harvestSecrets(env)
    expect(Array.from(harvested.keys())).toEqual(["AKEY_TOKEN", "MKEY_TOKEN", "ZKEY_TOKEN"])
  })
})

describe("harvestSecrets caching (no-arg / process.env)", () => {
  it("returns the same Map instance across no-arg calls, a fresh instance after reset, and an explicit-env call does not disturb the cache", () => {
    const first = harvestSecrets()
    const second = harvestSecrets()
    expect(second).toBe(first)

    // An explicit-env call in between must not populate or disturb the cache.
    harvestSecrets({ SOME_TOKEN: "fixture_value_0000000z" })
    const third = harvestSecrets()
    expect(third).toBe(first)

    resetForTest()
    const fourth = harvestSecrets()
    expect(fourth).not.toBe(first)
  })
})

describe("scrub", () => {
  it("replaces a planted process.env secret value with its marker", () => {
    plant({ REDACTION_TEST_API_KEY: "fixture_value_0000000a" })
    resetForTest()
    const output = scrub("the value is fixture_value_0000000a in the log")
    expect(output).toContain("[REDACTED:env:REDACTION_TEST_API_KEY]")
    expect(output).not.toContain("fixture_value_0000000a")
  })

  it("replaces multiple distinct secrets and all repeated occurrences", () => {
    plant({
      REDACTION_TEST_API_KEY: "fixture_value_0000000a",
      REDACTION_TEST_SECRET: "fixture_value_0000000b",
    })
    resetForTest()
    const input =
      "first fixture_value_0000000a then fixture_value_0000000b then fixture_value_0000000a again"
    const output = scrub(input)
    expect(output).not.toContain("fixture_value_0000000a")
    expect(output).not.toContain("fixture_value_0000000b")
    expect(output.match(/\[REDACTED:env:REDACTION_TEST_API_KEY\]/g)?.length).toBe(2)
    expect(output.match(/\[REDACTED:env:REDACTION_TEST_SECRET\]/g)?.length).toBe(1)
  })

  it("is idempotent: scrub(scrub(x)) === scrub(x), and the original value is absent", () => {
    plant({ REDACTION_TEST_API_KEY: "fixture_value_0000000a" })
    resetForTest()
    const input = "secret fixture_value_0000000a here"
    const once = scrub(input)
    const twice = scrub(once)
    expect(twice).toBe(once)
    expect(twice).not.toContain("fixture_value_0000000a")
  })

  it("returns text unchanged (strict equality) when there are no active secrets", () => {
    resetForTest()
    const input = "nothing sensitive here"
    expect(scrub(input)).toBe(input)
  })

  it("replaces values containing regex metacharacters via literal matching", () => {
    plant({ REDACTION_TEST_API_KEY: "p4$$w0rd.*+(x)" })
    resetForTest()
    const output = scrub("token: p4$$w0rd.*+(x) end")
    expect(output).toBe("token: [REDACTED:env:REDACTION_TEST_API_KEY] end")
  })

  it("replaces overlapping values correctly, leaving the longer replacement intact", () => {
    plant({
      REDACTION_TEST_API_KEY: "fixture_value_0000000a",
      REDACTION_TEST_API_KEY_2: "fixture_value_0000000a_longer",
    })
    resetForTest()
    const output = scrub("short fixture_value_0000000a and long fixture_value_0000000a_longer")
    expect(output).toContain("[REDACTED:env:REDACTION_TEST_API_KEY]")
    expect(output).toContain("[REDACTED:env:REDACTION_TEST_API_KEY_2]")
    expect(output).not.toContain("fixture_value_0000000a_longer")
    expect(output).not.toContain("fixture_value_0000000a and")
  })
})

describe("registerSecret", () => {
  it("registers a name that misses the harvest pattern; scrub and findSecrets pick it up; resetForTest clears it", () => {
    resetForTest()
    registerSecret("MY_CUSTOM_REF", "fixture_value_0000000r")
    const output = scrub("ref is fixture_value_0000000r here")
    expect(output).toBe("ref is [REDACTED:env:MY_CUSTOM_REF] here")
    expect(findSecrets("ref is fixture_value_0000000r here")).toEqual(["MY_CUSTOM_REF"])

    resetForTest()
    const afterReset = scrub("ref is fixture_value_0000000r here")
    expect(afterReset).toBe("ref is fixture_value_0000000r here")
    expect(findSecrets("ref is fixture_value_0000000r here")).toEqual([])
  })
})

describe("findSecrets", () => {
  it("returns sorted names for values present in text", () => {
    plant({
      REDACTION_TEST_API_KEY: "fixture_value_0000000a",
      REDACTION_TEST_SECRET: "fixture_value_0000000b",
    })
    resetForTest()
    const names = findSecrets("has fixture_value_0000000b and fixture_value_0000000a")
    expect(names).toEqual(["REDACTION_TEST_API_KEY", "REDACTION_TEST_SECRET"])
  })

  it("returns an empty array for clean text", () => {
    plant({ REDACTION_TEST_API_KEY: "fixture_value_0000000a" })
    resetForTest()
    expect(findSecrets("nothing sensitive here")).toEqual([])
  })

  it("never returns a planted VALUE as an element", () => {
    plant({ REDACTION_TEST_API_KEY: "fixture_value_0000000a" })
    resetForTest()
    const names = findSecrets("has fixture_value_0000000a")
    expect(names).not.toContain("fixture_value_0000000a")
  })
})

describe("inbound redaction markers", () => {
  it("INBOUND_MARKER_PATTERNS has exactly 3 entries", () => {
    expect(INBOUND_MARKER_PATTERNS.length).toBe(3)
  })

  it("detects each marker shape", () => {
    expect(containsRedactionMarker("x #AB12# y")).toBe(true)
    expect(containsRedactionMarker("[REDACTED:env:FOO]")).toBe(true)
    expect(containsRedactionMarker("a *** b")).toBe(true)
  })

  it("returns false for plain prose and for a lowercase hash marker", () => {
    expect(containsRedactionMarker("just some plain prose")).toBe(false)
    expect(containsRedactionMarker("#ab12#")).toBe(false)
  })
})

describe("scrub chokepoints (4b)", () => {
  async function withTmpDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scrub-4b-"))
    try {
      await fn(tmpDir)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  it("ledger: a delegation brief carrying a harvested value is redacted on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const ledgerPath = path.join(tmpDir, "ledger.json")
      plant({ SCRUB_4B_LEDGER_KEY: "fixture_value_4b00000a" })
      resetForTest()

      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: {
          s: "delegated",
          brief: "Worker brief: connect using fixture_value_4b00000a as the credential",
        },
      })

      const raw = await fs.readFile(ledgerPath, "utf-8")
      expect(raw).toContain("[REDACTED:env:SCRUB_4B_LEDGER_KEY]")
      expect(raw).not.toContain("fixture_value_4b00000a")
    })
  })

  it("journal: a log_event msg carrying a harvested value is redacted on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const journalPath = path.join(tmpDir, "journal.json")
      plant({ SCRUB_4B_JOURNAL_KEY: "fixture_value_4b00000b" })
      resetForTest()

      await initSession(journalPath, {
        operation: "init_session",
        data: {
          target_version: "0.5.0",
          branch: "release/v0.5.0",
          phase: 1,
          units: ["1a"],
          env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
        },
      })
      await logEvent(journalPath, {
        operation: "log_event",
        data: {
          t: "W_FAIL",
          u: "1a",
          tok: 100,
          msg: "worker leaked fixture_value_4b00000b in its output",
        },
      })

      const raw = await fs.readFile(journalPath, "utf-8")
      expect(raw).toContain("[REDACTED:env:SCRUB_4B_JOURNAL_KEY]")
      expect(raw).not.toContain("fixture_value_4b00000b")
    })
  })

  it("progress JSON: a log_error what_failed carrying a harvested value is redacted on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const progressPath = path.join(tmpDir, "progress.json")
      plant({ SCRUB_4B_PROGRESS_KEY: "fixture_value_4b00000c" })
      resetForTest()

      await writeProgress(progressPath, {
        operation: "log_error",
        data: {
          date: "2026-07-06",
          unit: "u1",
          what_failed: "crashed while using fixture_value_4b00000c",
          next_approach: "rotate and retry",
        },
      })

      const raw = await fs.readFile(progressPath, "utf-8")
      expect(raw).toContain("[REDACTED:env:SCRUB_4B_PROGRESS_KEY]")
      expect(raw).not.toContain("fixture_value_4b00000c")
    })
  })

  it("PROGRESS.md splice: hand-written body text carrying a harvested value is redacted on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const progressJsonPath = path.join(tmpDir, "progress.json")
      const ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
      const markdownPath = path.join(tmpDir, "PROGRESS.md")

      await fs.writeFile(
        ledgerPath,
        JSON.stringify({ v: 1, ts: "2026-07-06T00:00:00.000Z", phases: {} }),
        "utf-8"
      )

      plant({ SCRUB_4B_MARKDOWN_KEY: "fixture_value_4b00000d" })
      resetForTest()

      await fs.writeFile(
        markdownPath,
        `# Notes\nsee fixture_value_4b00000d for context\n${FENCE_START}\nold\n${FENCE_END}\n`,
        "utf-8"
      )

      await handleWriteProgress(
        progressJsonPath,
        {
          operation: "update_status",
          data: { unit_id: "u1", phase: "p1", status: "pending", notes: "n" },
        },
        tmpDir,
        ledgerPath
      )

      const raw = await fs.readFile(markdownPath, "utf-8")
      expect(raw).toContain("[REDACTED:env:SCRUB_4B_MARKDOWN_KEY]")
      expect(raw).not.toContain("fixture_value_4b00000d")
    })
  })

  it("negative sanity: with no planted secret, a normal write round-trips its text unchanged", async () => {
    await withTmpDir(async (tmpDir) => {
      resetForTest()
      const ledgerPath = path.join(tmpDir, "ledger.json")
      const brief = "Perfectly ordinary worker brief with nothing sensitive inside it"

      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief },
      })

      const raw = await fs.readFile(ledgerPath, "utf-8")
      expect(raw).toContain(brief)
      expect(raw).not.toContain("[REDACTED")
    })
  })
})
