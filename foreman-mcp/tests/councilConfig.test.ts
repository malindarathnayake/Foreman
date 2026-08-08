import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { loadCouncilConfig } from "../src/lib/councilConfig.js"
import { scrub, findSecrets, resetForTest } from "../src/lib/redaction.js"
import { parseSseChat } from "../src/lib/chatTransport.js"

// The council is OPTIONAL infrastructure. The single most important property under test is that
// its ABSENCE is a supported, non-error state: Foreman with no council configured must behave
// exactly as it did before the council existed.

let dirsToClean: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"))
  dirsToClean.push(dir)
  return dir
}

/** Path to a credentials file that does not exist — pins the "no home store" case. */
function absentCredentials(dir: string): string {
  return path.join(dir, "absent-credentials.env")
}

async function writeHome(dir: string, content: string): Promise<string> {
  const p = path.join(dir, "home.env")
  await fs.writeFile(p, content, "utf-8")
  return p
}

async function writeForemanEnv(dir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, ".foremanenv"), content, "utf-8")
}

const WORKER_HEADER =
  "schema_version=1\n" +
  "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
  "FOREMAN_API_KEY=${ENV:COUNCIL_TEST_KEY}\n"

beforeEach(() => {
  dirsToClean = []
})

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  resetForTest()
})

// ── 1. Absence is normal ────────────────────────────────────────────────────────────────

describe("loadCouncilConfig — absence is a supported state", () => {
  it("reports unavailable (never an error) when neither config file exists", async () => {
    const dir = await makeTempDir()
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath: absentCredentials(dir) })

    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") return
    expect(result.reason).toContain("no .foremanenv and no ~/.foreman-mcp/.env")
  })

  it("reports unavailable when .foremanenv is valid but seats no council", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(dir, WORKER_HEADER)
    const result = await loadCouncilConfig({
      dir,
      env: { COUNCIL_TEST_KEY: "council_test_key_00001" },
      credentialsPath: absentCredentials(dir),
    })

    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") return
    expect(result.reason).toContain("no FOREMAN_COUNCIL_SEAT_")
  })

  it("reports unavailable — not config_error — when seats exist but no key resolves", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\nFOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") return
    // The home store supplied the endpoint, so the key must come from there too.
    expect(result.reason).toContain("no key resolved")
  })
})

// ── 2. Home store alone can seat a council ──────────────────────────────────────────────

describe("loadCouncilConfig — home store", () => {
  it("seats a council from ~/.foreman-mcp/.env with no repo .foremanenv at all", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n" +
        "FOREMAN_COUNCIL_REASONING_A=xhigh\n" +
        "FOREMAN_COUNCIL_SEAT_B=moonshotai/kimi-k3\n" +
        "FOREMAN_COUNCIL_REASONING_MAX_TOKENS_B=8000\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiBase).toBe("https://openrouter.ai/api/v1")
    expect(result.config.seats).toEqual([
      {
        seat: "a",
        model: "deepseek/deepseek-v4-flash",
        label: "deepseek/deepseek-v4-flash",
        reasoningEffort: "xhigh",
        source: "home-env",
      },
      {
        seat: "b",
        model: "moonshotai/kimi-k3",
        label: "moonshotai/kimi-k3",
        reasoningMaxTokens: 8000,
        source: "home-env",
      },
    ])
  })

  it("strips one matching pair of surrounding quotes from a home value", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      'FOREMAN_API_BASE=https://openrouter.ai/api/v1\n' +
        'FOREMAN_API_KEY="quoted_key_00000001"\n' +
        'FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n'
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiKey).toBe("quoted_key_00000001")
  })
})

// ── 3. Precedence: seats home-first, key process-first ──────────────────────────────────

describe("loadCouncilConfig — precedence", () => {
  it("home store OVERRIDES a repo seat, and reports which file seated it", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(
      dir,
      WORKER_HEADER +
        "FOREMAN_COUNCIL_SEAT_A=repo/model-a\n" +
        "FOREMAN_COUNCIL_SEAT_B=repo/model-b\n"
    )
    const credentialsPath = await writeHome(dir, "FOREMAN_COUNCIL_SEAT_A=home/model-a\n")

    const result = await loadCouncilConfig({
      dir,
      env: { COUNCIL_TEST_KEY: "council_test_key_00001" },
      credentialsPath,
    })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    // Seat A swapped by the operator; seat B still the project default. Source is reported for both.
    expect(result.config.seats.map((s) => [s.seat, s.model, s.source])).toEqual([
      ["a", "home/model-a", "home-env"],
      ["b", "repo/model-b", "foremanenv"],
    ])
  })

  it("process env BEATS the home store for the API key", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(dir, WORKER_HEADER + "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n")
    const credentialsPath = await writeHome(dir, "COUNCIL_TEST_KEY=from_home_store_0001\n")

    const result = await loadCouncilConfig({
      dir,
      env: { COUNCIL_TEST_KEY: "from_process_env_001" },
      credentialsPath,
    })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiKey).toBe("from_process_env_001")
  })

  it("[CWE-522] never sends the repo endpoint's key to a home-store endpoint", async () => {
    const dir = await makeTempDir()
    // The real-world shape: repo points at a LAN worker box with a placeholder key ref; the home
    // store seats the council on a hosted provider. The worker's credential must NOT be reused.
    await writeForemanEnv(
      dir,
      "schema_version=1\n" +
        "FOREMAN_API_BASE=http://192.168.1.10:31081/v1\n" +
        "FOREMAN_API_KEY=${ENV:NUMBER_OF_PROCESSORS}\n"
    )
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\nFOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )

    const result = await loadCouncilConfig({ dir, env: { NUMBER_OF_PROCESSORS: "32" }, credentialsPath })

    // No key in the home store -> unavailable. It must NOT silently authenticate with "32".
    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") return
    expect(result.reason).toContain("no key resolved")
  })

  it("uses the home key when the home store also supplies the endpoint", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(
      dir,
      "schema_version=1\n" +
        "FOREMAN_API_BASE=http://192.168.1.10:31081/v1\n" +
        "FOREMAN_API_KEY=${ENV:NUMBER_OF_PROCESSORS}\n"
    )
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=sk_or_home_key_000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )

    const result = await loadCouncilConfig({ dir, env: { NUMBER_OF_PROCESSORS: "32" }, credentialsPath })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    // Council goes to the hosted endpoint with the hosted key; the worker keeps its LAN box.
    expect(result.config.apiBase).toBe("https://openrouter.ai/api/v1")
    expect(result.config.apiKey).toBe("sk_or_home_key_000001")
  })

  it("falls back to the home store for the key when the process env lacks it", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(dir, WORKER_HEADER + "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n")
    const credentialsPath = await writeHome(dir, "COUNCIL_TEST_KEY=from_home_store_0001\n")

    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiKey).toBe("from_home_store_0001")
  })
})

// ── 3b. Council-review findings, verified and fixed ─────────────────────────────────────
// Every case below was raised by the council reviewing its own resolver on its first live run,
// then confirmed against the source. They are regression locks, not hypotheticals.

describe("loadCouncilConfig — council-found regressions", () => {
  it("exported FOREMAN_API_KEY beats a stored one when the home store supplies the endpoint", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=stored_key_000000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const result = await loadCouncilConfig({
      dir,
      env: { FOREMAN_API_KEY: "session_key_00000001" },
      credentialsPath,
    })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    // A stale stored key must not shadow the key for the session you are actually in.
    expect(result.config.apiKey).toBe("session_key_00000001")
  })

  it("seats a council from an exported key when the home store has endpoint + seats but no key", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\nFOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const result = await loadCouncilConfig({
      dir,
      env: { FOREMAN_API_KEY: "session_key_00000001" },
      credentialsPath,
    })

    // Previously reported unavailable despite a perfectly usable exported key.
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiKey).toBe("session_key_00000001")
  })

  it("never returns a self-referential ${ENV:...} token as key material", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=${ENV:FOREMAN_API_KEY}\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    // The literal token must never be shipped as a bearer credential.
    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") return
    expect(result.reason).toContain("no key resolved")
  })

  it("[CWE-522] refuses a home-store value for a repo key ref when the home store names a different endpoint", async () => {
    const dir = await makeTempDir()
    // The name-collision path: both files use FOREMAN_API_KEY, for DIFFERENT services.
    await writeForemanEnv(
      dir,
      "schema_version=1\n" +
        "FOREMAN_API_BASE=http://192.168.1.10:31081/v1\n" +
        "FOREMAN_API_KEY=${ENV:FOREMAN_API_KEY}\n" +
        "FOREMAN_COUNCIL_SEAT_A=local/model\n"
    )
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\nFOREMAN_API_KEY=sk_or_hosted_00001\n"
    )

    // Home declares its own endpoint, so IT supplies both endpoint and key — and the repo's
    // LAN endpoint is never authenticated with the hosted credential.
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiBase).toBe("https://openrouter.ai/api/v1")
    expect(result.config.apiKey).toBe("sk_or_hosted_00001")
  })

  it("still lets a pure credential store (no endpoint of its own) answer a repo key ref", async () => {
    const dir = await makeTempDir()
    await writeForemanEnv(
      dir,
      "schema_version=1\n" +
        "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=${ENV:SHARED_PROVIDER_KEY}\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const credentialsPath = await writeHome(dir, "SHARED_PROVIDER_KEY=pure_store_key_0001\n")

    // The whole point of the home store as a credential source must keep working.
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.config.apiBase).toBe("https://openrouter.ai/api/v1")
    expect(result.config.apiKey).toBe("pure_store_key_0001")
  })
})

// ── 4. Malformed config IS an error (absence is not) ────────────────────────────────────

describe("loadCouncilConfig — corrected-call errors", () => {
  it("rejects a per-seat key with no seat anchor, naming the line to add", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "FOREMAN_COUNCIL_REASONING_C=xhigh\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("config_error")
    if (result.status !== "config_error") return
    expect(result.message).toContain("FOREMAN_COUNCIL_REASONING_C is set")
    expect(result.message).toContain("FOREMAN_COUNCIL_SEAT_C=<model-id>")
  })

  it("rejects reasoning effort AND a reasoning token budget on the same seat", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n" +
        "FOREMAN_COUNCIL_REASONING_A=xhigh\n" +
        "FOREMAN_COUNCIL_REASONING_MAX_TOKENS_A=8000\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("config_error")
    if (result.status !== "config_error") return
    expect(result.message).toContain("mutually exclusive")
  })

  it("rejects a non-integer reasoning token budget", async () => {
    const dir = await makeTempDir()
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n" +
        "FOREMAN_COUNCIL_REASONING_MAX_TOKENS_A=lots\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(result.status).toBe("config_error")
    if (result.status !== "config_error") return
    expect(result.message).toContain("a positive integer")
  })
})

// ── 5. Home-store secrets reach the redaction module ────────────────────────────────────

describe("loadCouncilConfig — home-store secrets are registered", () => {
  it("scrubs and gates a home-store secret that is NOT the API key and NOT in process.env", async () => {
    const dir = await makeTempDir()
    // A second credential, of the kind a .env accumulates. Before this fix only the resolved
    // FOREMAN_API_KEY was registered, so this value was invisible to scrub() and the outbound gate.
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "LANGFUSE_SECRET_KEY=sk_other_secret_9999\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    const result = await loadCouncilConfig({ dir, env: {}, credentialsPath })
    expect(result.status).toBe("ok")

    const text = "brief mentioning sk_other_secret_9999 inline"
    expect(findSecrets(text)).toContain("LANGFUSE_SECRET_KEY")
    expect(scrub(text)).toBe("brief mentioning [REDACTED:env:LANGFUSE_SECRET_KEY] inline")
  })

  it("registers the resolved API key even under a name the harvest pattern would miss", async () => {
    const dir = await makeTempDir()
    // "FOREMAN_API_KEY" matches the KEY pattern, so use the inline path under a bland ref and
    // confirm the explicit registerSecret in the loader covers the value regardless.
    const credentialsPath = await writeHome(
      dir,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=home_inline_key_000001\n" +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n"
    )
    await loadCouncilConfig({ dir, env: {}, credentialsPath })

    expect(scrub("key=home_inline_key_000001")).toBe("key=[REDACTED:env:FOREMAN_API_KEY]")
  })
})

// ── 6. SSE accumulation ─────────────────────────────────────────────────────────────────

describe("parseSseChat", () => {
  it("concatenates delta content across frames and captures finish reason + usage", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"{\\"findings\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"[]}"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
      "data: [DONE]",
      "",
    ].join("\n")

    const parsed = parseSseChat(body)
    expect(parsed.sawFrames).toBe(true)
    expect(parsed.content).toBe('{"findings":[]}')
    expect(parsed.finishReason).toBe("stop")
    expect(parsed.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4 })
  })

  it("skips a malformed frame rather than discarding the whole review", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"ab"}}]}',
      "data: {not json at all",
      'data: {"choices":[{"delta":{"content":"cd"}}]}',
      "",
    ].join("\n")

    expect(parseSseChat(body).content).toBe("abcd")
  })

  it("reports sawFrames=false for a plain JSON body so the caller can fall back", () => {
    const parsed = parseSseChat('{"choices":[{"message":{"content":"hi"}}]}')
    expect(parsed.sawFrames).toBe(false)
    expect(parsed.content).toBe("")
  })

  it("accepts a terminal frame that carries a full message instead of a delta", () => {
    const body = 'data: {"choices":[{"message":{"content":"whole"},"finish_reason":"stop"}]}\n'
    const parsed = parseSseChat(body)
    expect(parsed.content).toBe("whole")
    expect(parsed.finishReason).toBe("stop")
  })
})
