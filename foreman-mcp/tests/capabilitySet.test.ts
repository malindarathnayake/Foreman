import { describe, it, expect } from "vitest"
import { KNOWN_HOSTS } from "../src/lib/hostProfiles.js"
import {
  CAPABILITIES,
  SUPPORT,
  DEGRADATIONS,
  unsupportedCapabilities,
} from "../src/lib/capabilitySet.js"

describe("capabilitySet", () => {
  it("SUPPORT is total: every known host x every capability has a boolean", () => {
    for (const host of KNOWN_HOSTS) {
      for (const cap of CAPABILITIES) {
        expect(typeof SUPPORT[host][cap]).toBe("boolean")
      }
    }
  })

  it("CAPABILITIES is exactly the six expected names", () => {
    expect(CAPABILITIES).toEqual([
      "spawn-worker",
      "invoke-advisor",
      "run-tests",
      "report-tokens",
      "honor-isolation",
      "autonomy",
    ])
  })

  it("DEGRADATIONS has a non-empty string for every capability", () => {
    for (const cap of CAPABILITIES) {
      expect(typeof DEGRADATIONS[cap]).toBe("string")
      expect(DEGRADATIONS[cap].length).toBeGreaterThan(0)
    }
  })

  describe("unsupportedCapabilities", () => {
    it('claude-code supports all six -> "none"', () => {
      expect(unsupportedCapabilities("claude-code")).toBe("none")
    })

    it('cursor lacks autonomy -> "autonomy"', () => {
      expect(unsupportedCapabilities("cursor")).toBe("autonomy")
    })

    it('codex lacks autonomy -> "autonomy"', () => {
      expect(unsupportedCapabilities("codex")).toBe("autonomy")
    })

    it('generic supports all six -> "none"', () => {
      expect(unsupportedCapabilities("generic")).toBe("none")
    })
  })
})
