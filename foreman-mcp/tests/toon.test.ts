import { describe, it, expect } from "vitest"
import { toKeyValue, toTable } from "../src/lib/toon.js"

describe("toKeyValue", () => {
  it("produces key: value lines for string values", () => {
    const result = toKeyValue({ name: "foreman", env: "prod" })
    expect(result).toBe("name: foreman\nenv: prod")
  })

  it("produces key: value lines for number values", () => {
    const result = toKeyValue({ count: 42, version: 1 })
    expect(result).toBe("count: 42\nversion: 1")
  })

  it("produces key: value lines for boolean values", () => {
    const result = toKeyValue({ compatible: true, update_available: false })
    expect(result).toBe("compatible: true\nupdate_available: false")
  })

  it("handles mixed value types", () => {
    const result = toKeyValue({ bundle_version: "0.0.1", compatible: true, update_available: false })
    expect(result).toBe("bundle_version: 0.0.1\ncompatible: true\nupdate_available: false")
  })

  it("returns empty string for empty record", () => {
    const result = toKeyValue({})
    expect(result).toBe("")
  })
})

describe("toTable", () => {
  it("produces pipe-delimited table with headers and rows", () => {
    const result = toTable(["version", "date", "description"], [
      ["0.0.1", "2026-04-02", "Initial release"],
    ])
    expect(result).toBe("version | date | description\n0.0.1 | 2026-04-02 | Initial release")
  })

  it("produces table with multiple rows", () => {
    const result = toTable(["phase", "unit", "verdict"], [
      ["p1", "u1", "pass"],
      ["p1", "u2", "pending"],
    ])
    expect(result).toBe("phase | unit | verdict\np1 | u1 | pass\np1 | u2 | pending")
  })

  it("returns just the headers line when rows is empty", () => {
    const result = toTable(["version", "date", "description"], [])
    expect(result).toBe("version | date | description")
  })

  it("returns empty string when headers is empty", () => {
    const result = toTable([], [["a", "b"]])
    expect(result).toBe("")
  })

  it("returns empty string when both headers and rows are empty", () => {
    const result = toTable([], [])
    expect(result).toBe("")
  })
})
