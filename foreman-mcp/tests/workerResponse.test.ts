import { describe, it, expect } from "vitest"
import {
  canonicalize,
  parseWorkerResponse,
  normalizeFinishReason,
  PATCH_BEGIN,
  PATCH_END,
} from "../src/lib/workerResponse.js"
import type { EditFormat } from "../src/lib/workerResponse.js"

const DOCS_DIR = "Docs"

function wrapPatch(body: string): string {
  return `${PATCH_BEGIN}\n${body}\n${PATCH_END}`
}

function fullResponse(metadataJson: string, patchBody?: string, opts?: { prefix?: string }): string {
  const prefix = opts?.prefix ?? ""
  const patchSection = patchBody !== undefined ? `\n${wrapPatch(patchBody)}` : ""
  return `${prefix}${metadataJson}${patchSection}`
}

const UNIFIED_DIFF_BODY = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,2 +1,3 @@", " line1", "+line2", " line3"].join(
  "\n"
)

const SEARCH_REPLACE_BODY = [
  "src/x.ts",
  "<<<<<<< SEARCH",
  "old content",
  "=======",
  "new content",
  ">>>>>>> REPLACE",
].join("\n")

const WHOLE_FILE_BODY = ["===== FILE: src/x.ts =====", "export const x = 1"].join("\n")

const METADATA_SUCCESS = '{"report":"success","files":["src/x.ts"],"confidence":0.8}'

describe("canonicalize", () => {
  it("strips a leading BOM", () => {
    expect(canonicalize("﻿hello")).toBe("hello")
  })

  it("converts CRLF to LF", () => {
    expect(canonicalize("line1\r\nline2\r\n")).toBe("line1\nline2\n")
  })

  it("a full CRLF+BOM response parses identically to its LF form", () => {
    const lf = fullResponse(METADATA_SUCCESS, UNIFIED_DIFF_BODY)
    const crlfBom = "﻿" + lf.replace(/\n/g, "\r\n")

    const lfResult = parseWorkerResponse(lf, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    const crlfResult = parseWorkerResponse(crlfBom, { editFormat: "unified_diff", docsDir: DOCS_DIR })

    expect(crlfResult).toEqual(lfResult)
  })
})

describe("happy path per format", () => {
  const cases: Array<{ name: string; editFormat: EditFormat; body: string }> = [
    { name: "unified_diff", editFormat: "unified_diff", body: UNIFIED_DIFF_BODY },
    { name: "search_replace", editFormat: "search_replace", body: SEARCH_REPLACE_BODY },
    { name: "whole_file", editFormat: "whole_file", body: WHOLE_FILE_BODY },
  ]

  for (const { name, editFormat, body } of cases) {
    it(`${name}: classifies OK, patch is verbatim, targetPaths extracted`, () => {
      const raw = fullResponse(METADATA_SUCCESS, body)
      const result = parseWorkerResponse(raw, { editFormat, docsDir: DOCS_DIR })

      expect(result.classification).toBe("OK")
      expect(result.metadata).toEqual({ report: "success", files: ["src/x.ts"], confidence: 0.8 })
      expect(result.patch).toBe(body)
      expect(result.targetPaths).toEqual(["src/x.ts"])
    })
  }

  it("unified_diff: patch is byte-equal including trailing spaces on a line", () => {
    const bodyWithTrailingSpace = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,3 @@",
      " line1   ",
      "+line2",
      " line3",
    ].join("\n")
    const raw = fullResponse(METADATA_SUCCESS, bodyWithTrailingSpace)
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })

    expect(result.classification).toBe("OK")
    expect(result.patch).toBe(bodyWithTrailingSpace)
  })
})

describe("MODEL_SCHEMA_FAIL", () => {
  const run = (raw: string) => parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })

  it("no JSON at all", () => {
    const result = run("no metadata here, just prose\n" + wrapPatch(UNIFIED_DIFF_BODY))
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
    expect(result.metadata).toBeUndefined()
  })

  it("truncated JSON (unbalanced braces, never closes)", () => {
    const result = run('{"report": "success", "files": [')
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
  })

  it("malformed JSON syntax inside balanced braces (trailing comma)", () => {
    const result = run('{"report": "success",}')
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
  })

  it("report is non-string", () => {
    const result = run('{"report": 123, "files": ["a.ts"]}')
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
  })

  it("files is non-array", () => {
    const result = run('{"report": "success", "files": "not-an-array"}')
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
  })

  it("files array contains a non-string", () => {
    const result = run('{"report": "success", "files": ["a.ts", 42]}')
    expect(result.classification).toBe("MODEL_SCHEMA_FAIL")
  })

  it("prose before the JSON block does not prevent parsing (first balanced block found)", () => {
    const prose = "Here's my analysis of the codebase. I looked at everything.\n\n"
    const raw = fullResponse(METADATA_SUCCESS, UNIFIED_DIFF_BODY, { prefix: prose })
    const result = run(raw)
    expect(result.classification).toBe("OK")
    expect(result.metadata).toEqual({ report: "success", files: ["src/x.ts"], confidence: 0.8 })
  })

  it("a `{` inside a string in the metadata's own values does not break the brace scan", () => {
    const metadataJson = '{"report":"success","files":["src/x.ts"],"finish_note":"output has a { brace in it"}'
    const raw = fullResponse(metadataJson, UNIFIED_DIFF_BODY)
    const result = run(raw)
    expect(result.classification).toBe("OK")
    expect(result.metadata).toEqual({
      report: "success",
      files: ["src/x.ts"],
      finish_note: "output has a { brace in it",
    })
  })
})

describe("WORKER_GHOST", () => {
  const run = (raw: string) => parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })

  it("report success, no sentinels at all", () => {
    const result = run(METADATA_SUCCESS)
    expect(result.classification).toBe("WORKER_GHOST")
    expect(result.patch).toBeUndefined()
  })

  it("sentinels present but empty between them", () => {
    const raw = `${METADATA_SUCCESS}\n${PATCH_BEGIN}\n${PATCH_END}`
    const result = run(raw)
    expect(result.classification).toBe("WORKER_GHOST")
    expect(result.patch).toBe("")
  })

  it("sentinels present but whitespace-only between them", () => {
    const raw = `${METADATA_SUCCESS}\n${PATCH_BEGIN}\n   \n\t\n${PATCH_END}`
    const result = run(raw)
    expect(result.classification).toBe("WORKER_GHOST")
  })

  it("report NOT success with no patch classifies OK with patch undefined (honest failure is not a ghost)", () => {
    const raw = '{"report":"failure: could not locate target function","files":[]}'
    const result = run(raw)
    expect(result.classification).toBe("OK")
    expect(result.patch).toBeUndefined()
  })
})

describe("PATCH_PARSE_FAIL", () => {
  const run = (body: string, editFormat: EditFormat) =>
    parseWorkerResponse(fullResponse(METADATA_SUCCESS, body), { editFormat, docsDir: DOCS_DIR })

  it("unified_diff: no @@ hunk header", () => {
    const body = ["--- a/src/x.ts", "+++ b/src/x.ts", "-old", "+new"].join("\n")
    expect(run(body, "unified_diff").classification).toBe("PATCH_PARSE_FAIL")
  })

  it("unified_diff: missing --- / +++ headers", () => {
    const body = ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n")
    expect(run(body, "unified_diff").classification).toBe("PATCH_PARSE_FAIL")
  })

  it("search_replace: SEARCH marker with no REPLACE marker", () => {
    const body = ["src/x.ts", "<<<<<<< SEARCH", "old content", "======="].join("\n")
    expect(run(body, "search_replace").classification).toBe("PATCH_PARSE_FAIL")
  })

  it("whole_file: no ===== FILE: ... ===== marker", () => {
    const body = ["just some content", "with no marker at all"].join("\n")
    expect(run(body, "whole_file").classification).toBe("PATCH_PARSE_FAIL")
  })
})

describe("PATCH_REDACTION_MARKER_FAIL", () => {
  function unifiedDiffWith(markerLine: string): string {
    return ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,1 +1,1 @@", "-old", `+${markerLine}`].join("\n")
  }

  it("patch containing [REDACTED:env:FOO]", () => {
    const raw = fullResponse(METADATA_SUCCESS, unifiedDiffWith("new [REDACTED:env:FOO] value"))
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    expect(result.classification).toBe("PATCH_REDACTION_MARKER_FAIL")
  })

  it("patch containing #AB12#", () => {
    const raw = fullResponse(METADATA_SUCCESS, unifiedDiffWith("new #AB12# value"))
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    expect(result.classification).toBe("PATCH_REDACTION_MARKER_FAIL")
  })

  it("patch containing ***", () => {
    const raw = fullResponse(METADATA_SUCCESS, unifiedDiffWith("new *** value"))
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    expect(result.classification).toBe("PATCH_REDACTION_MARKER_FAIL")
  })
})

describe("PATCH_PROTECTED_PATH_FAIL", () => {
  function wholeFileWithPath(targetPath: string): string {
    return [`===== FILE: ${targetPath} =====`, "some content"].join("\n")
  }

  function classify(targetPath: string): string {
    const raw = fullResponse(METADATA_SUCCESS, wholeFileWithPath(targetPath))
    return parseWorkerResponse(raw, { editFormat: "whole_file", docsDir: DOCS_DIR }).classification
  }

  const protectedCases: Array<[string, string]> = [
    ["docs-dir exact case", "Docs/.foreman-ledger.json"],
    ["docs-dir case variant", "docs/spec.md"],
    ["dotfile at root", ".foreman-events.jsonl"],
    ["dotfile nested", "sub/dir/.foreman-x"],
    ["git dir at root", ".git/config"],
    ["git dir nested", "a/.git/hooks/x"],
    ["posix traversal", "../outside.ts"],
    ["mixed-separator traversal", "..\\outside.ts"],
    ["windows absolute", "C:\\Windows\\evil.ts"],
    ["posix absolute", "/etc/passwd"],
    ["normalizes to traversal", "src/../../escape.ts"],
  ]

  for (const [label, targetPath] of protectedCases) {
    it(`${label}: "${targetPath}" is protected`, () => {
      expect(classify(targetPath)).toBe("PATCH_PROTECTED_PATH_FAIL")
    })
  }

  it("negative: src/lib/good.ts is not protected", () => {
    expect(classify("src/lib/good.ts")).toBe("OK")
  })

  it("negative: Docsy/notdocs.ts (prefix near-miss) is not protected", () => {
    expect(classify("Docsy/notdocs.ts")).toBe("OK")
  })
})

describe("classification precedence", () => {
  it("a patch that both fails well-formedness AND contains a marker classifies PATCH_PARSE_FAIL (3 before 4)", () => {
    const body = ["--- a/src/x.ts", "+++ b/src/x.ts", "some *** marker text without a hunk header"].join("\n")
    const raw = fullResponse(METADATA_SUCCESS, body)
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    expect(result.classification).toBe("PATCH_PARSE_FAIL")
  })

  it("a well-formed patch containing a marker AND a protected path classifies PATCH_REDACTION_MARKER_FAIL (4 before 5)", () => {
    const body = ["--- a/before.ts", "+++ b/.git/config", "@@ -1,1 +1,1 @@", "-old", "+new ***"].join("\n")
    const raw = fullResponse(METADATA_SUCCESS, body)
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })
    expect(result.classification).toBe("PATCH_REDACTION_MARKER_FAIL")
  })
})

describe("normalizeFinishReason", () => {
  it.each([
    ["stop", "stop"],
    ["STOP", "stop"],
    ["length", "length"],
    ["LENGTH", "length"],
    ["content_filter", "content_filter"],
    ["CONTENT_FILTER", "content_filter"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeFinishReason(input)).toBe(expected)
  })

  it.each([["eos"], [""], [undefined], [null], [42]])("%p -> other", (input) => {
    expect(normalizeFinishReason(input)).toBe("other")
  })
})

describe("verbatim guarantee", () => {
  it("odd-but-legal content (trailing whitespace, tabs, unicode) round-trips byte-identical", () => {
    const body = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,3 +1,3 @@",
      " line with trailing spaces   ",
      "+\tline with a leading tab",
      " unicode: café ✅ 你好",
    ].join("\n")
    const raw = fullResponse(METADATA_SUCCESS, body)
    const result = parseWorkerResponse(raw, { editFormat: "unified_diff", docsDir: DOCS_DIR })

    expect(result.classification).toBe("OK")
    expect(result.patch).toBe(body)
  })
})
