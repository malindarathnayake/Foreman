import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "node:child_process"
import { loadForemanEnv, aiderEditFormat } from "../src/lib/foremanEnv.js"
import { scrub, resetForTest } from "../src/lib/redaction.js"
import { initSession } from "../src/lib/journal.js"

// --- Fixture helpers -------------------------------------------------------------

let dirsToClean: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foremanenv-test-"))
  dirsToClean.push(dir)
  return dir
}

async function writeForemanEnv(dir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, ".foremanenv"), content, "utf-8")
}

function gitInit(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
}

beforeEach(() => {
  dirsToClean = []
})

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  resetForTest()
})

// The normative example file from the worker brief, verbatim (em dash written as an
// escape to keep this source file plain-ASCII and encoding-safe).
const HAPPY_PATH_CONTENT = `# Foreman worker-invoker config. Keys NEVER inline — \${ENV:NAME} indirection only.
schema_version=1
FOREMAN_API_BASE=https://openrouter.ai/api/v1
FOREMAN_API_KEY=\${ENV:OPENROUTER_API_KEY}
FOREMAN_TIER_CHEAP=qwen/qwen3-coder-30b
FOREMAN_TIER_STANDARD=zhipu/glm-4.5
FOREMAN_TIER_PREMIUM=anthropic/claude-sonnet-4.6
FOREMAN_WORKER_CLASS_CHEAP=compact
FOREMAN_WORKER_CLASS_STANDARD=capable
FOREMAN_WORKER_CLASS_PREMIUM=frontier
FOREMAN_EDIT_FORMAT_CHEAP=whole_file        # optional; default unified_diff
FOREMAN_REASONING_EFFORT_CHEAP=high         # optional; verbatim passthrough, family-specific
`

const FIXTURE_KEY_VALUE = "fixture_key_4c000001"

function expectHappyPathConfig(config: unknown): void {
  expect(config).toEqual({
    apiBase: "https://openrouter.ai/api/v1",
    apiKeyRef: "OPENROUTER_API_KEY",
    schemaVersion: 1,
    tiers: {
      cheap: {
        model: "qwen/qwen3-coder-30b",
        workerClass: "compact",
        editFormat: "whole_file",
        reasoningEffort: "high",
        workerKind: "remote-chat",
        maxReflections: 3,
      },
      standard: {
        model: "zhipu/glm-4.5",
        workerClass: "capable",
        editFormat: "unified_diff",
        workerKind: "remote-chat",
        maxReflections: 3,
      },
      premium: {
        model: "anthropic/claude-sonnet-4.6",
        workerClass: "frontier",
        editFormat: "unified_diff",
        workerKind: "remote-chat",
        maxReflections: 3,
      },
    },
  })
}

describe("loadForemanEnv", () => {
  describe("happy path", () => {
    it("parses the full example file, resolves the key, and registers it with redaction", async () => {
      const dir = await makeTempDir()
      // dir is a fresh mkdtemp with no .git anywhere -- this also exercises the
      // "non-git temp dir -> probes pass" case (test 8 in the brief).
      await writeForemanEnv(dir, HAPPY_PATH_CONTENT)

      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })

      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expectHappyPathConfig(result.config)

      // registerSecret effect observable via scrub().
      const scrubbed = scrub(`token is ${FIXTURE_KEY_VALUE} in transit`)
      expect(scrubbed).toContain("[REDACTED:env:OPENROUTER_API_KEY]")
      expect(scrubbed).not.toContain(FIXTURE_KEY_VALUE)
    })

    it("produces an identical result for a CRLF + UTF-8 BOM variant of the same file", async () => {
      const dir = await makeTempDir()
      const crlfContent = "﻿" + HAPPY_PATH_CONTENT.replace(/\n/g, "\r\n")
      await writeForemanEnv(dir, crlfContent)

      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })

      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expectHappyPathConfig(result.config)
    })

    it("zero configured tiers is structurally valid", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n"
      )

      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })

      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers).toEqual({})
    })
  })

  describe("missing file", () => {
    it("returns config_error naming the exact path checked", async () => {
      const dir = await makeTempDir()
      const result = await loadForemanEnv({ dir })

      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain(path.join(dir, ".foremanenv"))
      expect(result.message).toContain("schema_version=1")
    })
  })

  describe("corrected-call error texts (verbatim fragments)", () => {
    it("missing schema_version", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "# nothing configured yet\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("missing required key 'schema_version'")
      expect(result.message).toContain("schema_version=1")
    })

    it("unsupported schema_version", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=2\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'schema_version'")
      expect(result.message).toContain("'2'")
      expect(result.message).toContain("Supported values: 1")
    })

    it("missing FOREMAN_API_BASE", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("missing required key 'FOREMAN_API_BASE'")
      expect(result.message).toContain("FOREMAN_API_BASE=https://openrouter.ai/api/v1")
    })

    it("bad URL for FOREMAN_API_BASE", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nFOREMAN_API_BASE=not-a-url\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_API_BASE'")
      expect(result.message).toContain("not-a-url")
    })

    it("missing FOREMAN_API_KEY", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nFOREMAN_API_BASE=https://openrouter.ai/api/v1\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("missing required key 'FOREMAN_API_KEY'")
      expect(result.message).toContain("FOREMAN_API_KEY=${ENV:YOUR_KEY_ENV_VAR}")
    })

    it("inline (non-${ENV:}) FOREMAN_API_KEY never echoes the offending value", async () => {
      const dir = await makeTempDir()
      const inlineFixture = "fixture_inline_0000001"
      await writeForemanEnv(
        dir,
        `schema_version=1\nFOREMAN_API_BASE=https://openrouter.ai/api/v1\nFOREMAN_API_KEY=${inlineFixture}\n`
      )
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_API_KEY'")
      expect(result.message).toContain("${ENV:NAME}")
      expect(result.message).not.toContain(inlineFixture)
    })

    it("unresolvable env NAME names the var but never a value", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:FOREMANENV_TEST_UNSET_VAR}\n"
      )
      const result = await loadForemanEnv({ dir, env: {} })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toBe(
        "environment variable 'FOREMANENV_TEST_UNSET_VAR' is not set — export it before starting the server"
      )
    })

    it("configured tier missing its worker class names the exact line AND which tiers ARE configured", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-coder-30b\n" +
          "FOREMAN_TIER_STANDARD=zhipu/glm-4.5\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("tier 'cheap' is configured (FOREMAN_TIER_CHEAP)")
      expect(result.message).toContain("FOREMAN_WORKER_CLASS_CHEAP=<frontier|capable|compact>")
      expect(result.message).toContain("Configured tiers: cheap, standard")
    })

    it("orphan worker-class without its tier names the missing FOREMAN_TIER_<T> line", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_WORKER_CLASS_STANDARD=capable\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain(
        "FOREMAN_WORKER_CLASS_STANDARD is set but tier 'standard' is not configured"
      )
      expect(result.message).toContain("FOREMAN_TIER_STANDARD=<model-id>")
    })

    it("unsupported worker class value", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-coder-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=bogus\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_WORKER_CLASS_CHEAP'")
      expect(result.message).toContain("Supported values: frontier, capable, compact")
    })

    it("unsupported edit format value", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-coder-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_EDIT_FORMAT_CHEAP=bogus\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_EDIT_FORMAT_CHEAP'")
      expect(result.message).toContain("Supported values: unified_diff, search_replace, whole_file")
    })

    it("unknown key lists all recognized keys", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nFOREMAN_BOGUS_KEY=x\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unknown key 'FOREMAN_BOGUS_KEY'")
      expect(result.message).toContain("schema_version")
      expect(result.message).toContain("FOREMAN_API_BASE")
      expect(result.message).toContain("FOREMAN_API_KEY")
      expect(result.message).toContain("FOREMAN_TIER_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_WORKER_CLASS_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_EDIT_FORMAT_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_REASONING_EFFORT_<CHEAP|STANDARD|PREMIUM>")
    })

    it("duplicate key names the key", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nschema_version=1\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("duplicate key 'schema_version'")
    })
  })

  describe("git refusal", () => {
    it("refuses a git-tracked .foremanenv, journals SEC_BLOCK, and never throws for a bad journalPath", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\n")
      gitInit(dir)
      execFileSync("git", ["add", ".foremanenv"], { cwd: dir, stdio: "ignore" })

      const journalPath = path.join(dir, "journal.json")
      await initSession(journalPath, {
        operation: "init_session",
        data: {
          target_version: "0.5.0",
          branch: "release/v0.5.0",
          phase: 1,
          units: ["4c"],
          env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
        },
      })

      const result = await loadForemanEnv({ dir, journalPath })
      expect(result.status).toBe("refused")
      if (result.status !== "refused") return
      expect(result.message).toContain("echo .foremanenv >> .gitignore")
      expect(result.message).toContain("git rm --cached .foremanenv")

      const journalRaw = await fs.readFile(journalPath, "utf-8")
      expect(journalRaw).toContain("SEC_BLOCK")

      // Best-effort proven: an unusable journalPath must never throw into the loader.
      const badJournalPath = path.join(dir, "does-not-exist", "nested", "journal.json")
      await expect(loadForemanEnv({ dir, journalPath: badJournalPath })).resolves.toMatchObject({
        status: "refused",
      })
    })

    it("refuses an untracked, non-git-ignored .foremanenv", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\n")
      gitInit(dir)
      // No .gitignore, no `git add` -- untracked and unprotected.

      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("refused")
      if (result.status !== "refused") return
      expect(result.message).toContain("echo .foremanenv >> .gitignore")
      expect(result.message).not.toContain("git rm --cached")
    })

    it("proceeds to parse when untracked AND git-ignored", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, HAPPY_PATH_CONTENT)
      gitInit(dir)
      await fs.writeFile(path.join(dir, ".gitignore"), ".foremanenv\n", "utf-8")

      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: FIXTURE_KEY_VALUE } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expectHappyPathConfig(result.config)
    })
  })

  describe("worker_kind axis (unit 1a)", () => {
    it("recognizes an aider-cli tier config (loads ok)", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
          "FOREMAN_NUM_CTX_CHEAP=262144\n" +
          "FOREMAN_MAX_REFLECTIONS_CHEAP=3\n" +
          "FOREMAN_REASONING_TAG_CHEAP=think\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1a000001" } })
      expect(result.status).toBe("ok")
    })

    it("recognizes a remote-chat worker_kind", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_PREMIUM=anthropic/claude-sonnet-4.6\n" +
          "FOREMAN_WORKER_CLASS_PREMIUM=frontier\n" +
          "FOREMAN_WORKER_KIND_PREMIUM=remote-chat\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1a000001" } })
      expect(result.status).toBe("ok")
    })

    it("unsupported worker_kind value", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=bogus\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1a000001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_WORKER_KIND_CHEAP'")
      expect(result.message).toContain("Supported values: remote-chat, aider-cli")
    })

    it("tier-suffix typo is rejected as unknown", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nFOREMAN_WORKER_KIND_CHEEP=aider-cli\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unknown key 'FOREMAN_WORKER_KIND_CHEEP'")
    })

    it("recognized-keys list advertises the new axis keys", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(dir, "schema_version=1\nFOREMAN_BOGUS_KEY=x\n")
      const result = await loadForemanEnv({ dir })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("FOREMAN_WORKER_KIND_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_NUM_CTX_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_MAX_REFLECTIONS_<CHEAP|STANDARD|PREMIUM>")
      expect(result.message).toContain("FOREMAN_REASONING_TAG_<CHEAP|STANDARD|PREMIUM>")
    })
  })

  describe("tier resolution (unit 1b)", () => {
    it("aider-cli tier fully resolves", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_EDIT_FORMAT_CHEAP=whole_file\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
          "FOREMAN_NUM_CTX_CHEAP=262144\n" +
          "FOREMAN_MAX_REFLECTIONS_CHEAP=5\n" +
          "FOREMAN_REASONING_TAG_CHEAP=think\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.cheap).toEqual({
        model: "qwen/qwen3-30b",
        workerClass: "compact",
        editFormat: "whole_file",
        workerKind: "aider-cli",
        numCtx: 262144,
        maxReflections: 5,
        reasoningTag: "think",
      })
    })

    it("absent worker_kind defaults to remote-chat with maxReflections 3", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_STANDARD=zhipu/glm-4.5\n" +
          "FOREMAN_WORKER_CLASS_STANDARD=capable\n" +
          "FOREMAN_EDIT_FORMAT_STANDARD=unified_diff\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.standard).toEqual({
        model: "zhipu/glm-4.5",
        workerClass: "capable",
        editFormat: "unified_diff",
        workerKind: "remote-chat",
        maxReflections: 3,
      })
    })

    it("aider-cli tier missing num_ctx is a corrected-call error", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("FOREMAN_NUM_CTX_CHEAP")
      expect(result.message).toContain("aider-cli")
    })

    it("non-integer num_ctx", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
          "FOREMAN_NUM_CTX_CHEAP=lots\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_NUM_CTX_CHEAP'")
    })

    it("non-integer max_reflections", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_MAX_REFLECTIONS_CHEAP=many\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_MAX_REFLECTIONS_CHEAP'")
    })

    it("remote-chat tier may carry num_ctx", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_STANDARD=zhipu/glm-4.5\n" +
          "FOREMAN_WORKER_CLASS_STANDARD=capable\n" +
          "FOREMAN_WORKER_KIND_STANDARD=remote-chat\n" +
          "FOREMAN_NUM_CTX_STANDARD=131072\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.standard?.numCtx).toBe(131072)
      expect(result.config.tiers.standard?.workerKind).toBe("remote-chat")
    })

    it("loopback coherence: warns on non-loopback base, silent on loopback", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const dir1 = await makeTempDir()
        await writeForemanEnv(
          dir1,
          "schema_version=1\n" +
            "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
            "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
            "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
            "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
            "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
            "FOREMAN_NUM_CTX_CHEAP=262144\n"
        )
        const result1 = await loadForemanEnv({ dir: dir1, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
        expect(result1.status).toBe("ok")
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("not a loopback URL"))

        spy.mockClear()

        const dir2 = await makeTempDir()
        await writeForemanEnv(
          dir2,
          "schema_version=1\n" +
            "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
            "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
            "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
            "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
            "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
            "FOREMAN_NUM_CTX_CHEAP=262144\n"
        )
        const result2 = await loadForemanEnv({ dir: dir2, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
        expect(result2.status).toBe("ok")
        expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("not a loopback URL"))
      } finally {
        spy.mockRestore()
      }
    })

    it("orphan new-axis key names the missing FOREMAN_TIER_<T> line", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_NUM_CTX_CHEAP=262144\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1b000001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("FOREMAN_NUM_CTX_CHEAP is set but tier 'cheap' is not configured")
    })
  })

  describe("p1 hardening (checkpoint fixes)", () => {
    it("empty max_reflections rejected", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_MAX_REFLECTIONS_CHEAP=\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_MAX_REFLECTIONS_CHEAP'")
    })

    it("empty num_ctx rejected on aider-cli", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
          "FOREMAN_NUM_CTX_CHEAP=\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_NUM_CTX_CHEAP'")
    })

    it("scientific-notation num_ctx is rejected", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
          "FOREMAN_NUM_CTX_CHEAP=1e3\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_NUM_CTX_CHEAP'")
    })

    it("hex-notation max_reflections is rejected", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_MAX_REFLECTIONS_CHEAP=0x2\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
      expect(result.status).toBe("config_error")
      if (result.status !== "config_error") return
      expect(result.message).toContain("unsupported value for 'FOREMAN_MAX_REFLECTIONS_CHEAP'")
    })

    it("127.0.0.0/8 is treated as loopback (no warning)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const dir = await makeTempDir()
        await writeForemanEnv(
          dir,
          "schema_version=1\n" +
            "FOREMAN_API_BASE=http://127.0.0.2:8787/v1\n" +
            "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
            "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
            "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
            "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
            "FOREMAN_NUM_CTX_CHEAP=262144\n"
        )
        const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
        expect(result.status).toBe("ok")
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain("is not a loopback URL")
          }
        }
      } finally {
        spy.mockRestore()
      }
    })

    it("[CWE-532] warning does not echo embedded credentials", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const dir = await makeTempDir()
        await writeForemanEnv(
          dir,
          "schema_version=1\n" +
            "FOREMAN_API_BASE=https://user:supersecret@example.com/v1?token=abc123\n" +
            "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
            "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
            "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
            "FOREMAN_WORKER_KIND_CHEAP=aider-cli\n" +
            "FOREMAN_NUM_CTX_CHEAP=262144\n"
        )
        const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_hard001" } })
        expect(result.status).toBe("ok")

        expect(spy).toHaveBeenCalledWith(expect.stringContaining("is not a loopback URL"))

        for (const call of spy.mock.calls) {
          for (const arg of call) {
            const s = String(arg)
            expect(s).not.toContain("supersecret")
            expect(s).not.toContain("abc123")
            expect(s).not.toContain("user:")
          }
        }
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe("edit_format seam (unit 1c)", () => {
    it("aiderEditFormat maps internal edit_format names to aider CLI names", () => {
      expect(aiderEditFormat("whole_file")).toBe("whole")
      expect(aiderEditFormat("search_replace")).toBe("diff")
      expect(aiderEditFormat("unified_diff")).toBe("udiff")
    })

    it("compact tier defaults to whole_file when edit_format is unset", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1c000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.cheap?.editFormat).toBe("whole_file")
    })

    it("capable tier defaults to unified_diff when edit_format is unset", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_STANDARD=zhipu/glm-4.5\n" +
          "FOREMAN_WORKER_CLASS_STANDARD=capable\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1c000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.standard?.editFormat).toBe("unified_diff")
    })

    it("frontier tier defaults to unified_diff when edit_format is unset", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_PREMIUM=anthropic/claude-sonnet-4.6\n" +
          "FOREMAN_WORKER_CLASS_PREMIUM=frontier\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1c000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.premium?.editFormat).toBe("unified_diff")
    })

    it("explicit edit_format overrides the compact-class default", async () => {
      const dir = await makeTempDir()
      await writeForemanEnv(
        dir,
        "schema_version=1\n" +
          "FOREMAN_API_BASE=http://localhost:8787/v1\n" +
          "FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}\n" +
          "FOREMAN_TIER_CHEAP=qwen/qwen3-30b\n" +
          "FOREMAN_WORKER_CLASS_CHEAP=compact\n" +
          "FOREMAN_EDIT_FORMAT_CHEAP=unified_diff\n"
      )
      const result = await loadForemanEnv({ dir, env: { OPENROUTER_API_KEY: "fixture_key_1c000001" } })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(result.config.tiers.cheap?.editFormat).toBe("unified_diff")
    })
  })
})
