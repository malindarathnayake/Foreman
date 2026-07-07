import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  getStackProfile,
  resolveStackProfile,
  parseSectionTags,
} from "../src/lib/stackProfiles.js"
import { loadSkill, renderStackSections } from "../src/lib/skillLoader.js"

let tmpDir: string
let docsDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stackprofiles-test-"))
  docsDir = path.join(tmpDir, "Docs")
  await fs.mkdir(docsDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ── helpers ────────────────────────────────────────────────────────────────

function makeOverride(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([id, body]) => `<!-- section: ${id} -->\n${body}\n<!-- /section -->`)
    .join("\n\n")
}

// ── bundled reference profile ───────────────────────────────────────────────

describe("getStackProfile — bundled reference profile", () => {
  it("returns id 'reference' with exactly the expected section keys", () => {
    const profile = getStackProfile("reference")
    expect(profile.id).toBe("reference")
    expect(Object.keys(profile.sections).sort()).toEqual(
      ["security-frameworks", "telemetry-backends"].sort()
    )
  })

  it("telemetry-backends section contains the corrected facts", () => {
    const profile = getStackProfile("reference")
    const body = profile.sections["telemetry-backends"]
    expect(body).toContain("InfluxDB")
    expect(body).toContain("no GELF exporter")
    expect(body).toContain("snake_case")
    expect(body).toContain("trace_id")
  })

  it("security-frameworks section references ATT&CK and ATLAS", () => {
    const profile = getStackProfile("reference")
    const body = profile.sections["security-frameworks"]
    expect(body).toContain("ATT&CK")
    expect(body).toContain("ATLAS")
  })
})

// ── resolveStackProfile precedence ──────────────────────────────────────────

describe("resolveStackProfile — precedence", () => {
  it("env 'reference' wins even when an override file exists", async () => {
    await fs.writeFile(
      path.join(docsDir, "foreman-stack-profile.md"),
      makeOverride({ "telemetry-backends": "OVERRIDE_BODY" })
    )

    const profile = await resolveStackProfile({ env: "reference", docsDir })
    expect(profile.id).toBe("reference")
  })

  it("env unset + override file with two sections → 'override' profile with parsed bodies", async () => {
    await fs.writeFile(
      path.join(docsDir, "foreman-stack-profile.md"),
      makeOverride({
        "telemetry-backends": "CUSTOM_TELEMETRY",
        "security-frameworks": "CUSTOM_SECURITY",
      })
    )

    const profile = await resolveStackProfile({ env: undefined, docsDir })
    expect(profile.id).toBe("override")
    expect(profile.sections["telemetry-backends"]).toBe("CUSTOM_TELEMETRY")
    expect(profile.sections["security-frameworks"]).toBe("CUSTOM_SECURITY")
  })

  it("env unset + no override file → 'reference'", async () => {
    const profile = await resolveStackProfile({ env: undefined, docsDir })
    expect(profile.id).toBe("reference")
  })

  it("env 'bogus' → warns once (mentions bogus and reference) and returns reference; override file NOT consulted", async () => {
    await fs.writeFile(
      path.join(docsDir, "foreman-stack-profile.md"),
      makeOverride({ "telemetry-backends": "SHOULD_NOT_BE_USED" })
    )

    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const profile = await resolveStackProfile({ env: "bogus", docsDir })
      expect(profile.id).toBe("reference")
      expect(spy).toHaveBeenCalledTimes(1)
      const message = spy.mock.calls[0].join(" ")
      expect(message).toContain("bogus")
      expect(message).toContain("reference")
    } finally {
      spy.mockRestore()
    }
  })

  it("override file present but zero sections parse → warns and returns reference", async () => {
    await fs.writeFile(path.join(docsDir, "foreman-stack-profile.md"), "no section tags here")

    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const profile = await resolveStackProfile({ env: undefined, docsDir })
      expect(profile.id).toBe("reference")
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

// ── parseSectionTags ─────────────────────────────────────────────────────────

describe("parseSectionTags", () => {
  it("parses a single tagged section into a map", () => {
    const source = "<!-- section: foo -->\nBODY\n<!-- /section -->"
    const map = parseSectionTags(source)
    expect(map.get("foo")).toBe("BODY")
  })
})

// ── renderStackSections ──────────────────────────────────────────────────────

describe("renderStackSections", () => {
  it("replaces {{stack: telemetry-backends}} with the reference body", () => {
    const profile = getStackProfile("reference")
    const out = renderStackSections("before {{stack: telemetry-backends}} after", profile)
    expect(out).toContain("InfluxDB")
    expect(out).not.toContain("{{stack:")
  })

  it("tolerates whitespace {{ stack: telemetry-backends }}", () => {
    const profile = getStackProfile("reference")
    const out = renderStackSections("X {{ stack: telemetry-backends }} Y", profile)
    expect(out).toContain("InfluxDB")
    expect(out).not.toContain("{{")
  })

  it("unknown id renders [[MISSING STACK SECTION: nope]] and warns", () => {
    const profile = getStackProfile("reference")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const out = renderStackSections("{{stack: nope}}", profile)
      expect(out).toContain("[[MISSING STACK SECTION: nope]]")
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("content without markers is returned unchanged", () => {
    const profile = getStackProfile("reference")
    const out = renderStackSections("plain content, no markers", profile)
    expect(out).toBe("plain content, no markers")
  })
})

// ── loadSkill integration ────────────────────────────────────────────────────

describe("loadSkill — stack section integration", () => {
  let bundledDir: string

  beforeEach(async () => {
    bundledDir = path.join(tmpDir, "bundled")
    await fs.mkdir(bundledDir, { recursive: true })
  })

  it("renders {{stack: security-frameworks}} from the default reference profile", async () => {
    await fs.writeFile(
      path.join(bundledDir, "s.md"),
      "before\n{{stack: security-frameworks}}\nafter"
    )

    const result = await loadSkill("s", bundledDir)
    expect(result.content).toContain("ATT&CK")
    expect(result.content).not.toContain("{{stack:")
  })

  it("uses a custom stack profile passed as the 4th arg", async () => {
    await fs.writeFile(
      path.join(bundledDir, "s.md"),
      "before\n{{stack: security-frameworks}}\nafter"
    )

    const result = await loadSkill("s", bundledDir, "claude-code", {
      id: "x",
      displayName: "X",
      sections: { "security-frameworks": "CUSTOM BODY" },
    })
    expect(result.content).toContain("CUSTOM BODY")
  })
})
