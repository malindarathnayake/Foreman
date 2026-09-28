import { describe, it, expect } from "vitest"
import { quoteMermaidEdgeLabels, quoteMermaidLabel } from "../src/lib/mermaidLabels.js"

const FORCE = `flowchart TD
  D -- no / --force --> O[ACME out]
`

const FORCE_QUOTED = `flowchart TD
  D -- "no / --force" --> O[ACME out]
`

describe("quoteMermaidLabel", () => {
  it("wraps bare text and leaves already-quoted text", () => {
    expect(quoteMermaidLabel(" no / --force ")).toBe('"no / --force"')
    expect(quoteMermaidLabel('"already"')).toBe('"already"')
    expect(quoteMermaidLabel("'already'")).toBe("'already'")
    expect(quoteMermaidLabel('say "hi"')).toBe('"say #quot;hi#quot;"')
  })
})

describe("quoteMermaidEdgeLabels", () => {
  it("quotes the mermaid-11 lexer bomb: --force inside an unquoted edge label", () => {
    expect(quoteMermaidEdgeLabels(FORCE)).toBe(FORCE_QUOTED)
  })

  it("is idempotent", () => {
    expect(quoteMermaidEdgeLabels(FORCE_QUOTED)).toBe(FORCE_QUOTED)
    expect(quoteMermaidEdgeLabels(quoteMermaidEdgeLabels(FORCE))).toBe(FORCE_QUOTED)
  })

  it("leaves unlabeled arrows and pipe labels alone", () => {
    const src = [
      "flowchart TD",
      "  A-->B",
      "  A --- B",
      "  A --o B",
      "  A --x B",
      "  A -->|no / --force| B",
      "  A -.-> C",
      "  A ==> D",
    ].join("\n")
    expect(quoteMermaidEdgeLabels(src)).toBe(src)
  })

  it("quotes dotted and thick labeled edges", () => {
    expect(quoteMermaidEdgeLabels("A -. no / --force .-> B")).toBe(
      'A -. "no / --force" .-> B'
    )
    expect(quoteMermaidEdgeLabels("A == no / --force ==> B")).toBe(
      'A == "no / --force" ==> B'
    )
  })

  it("quotes solid unlabeled-style --- with a label", () => {
    expect(quoteMermaidEdgeLabels("A -- wait --- B")).toBe('A -- "wait" --- B')
  })

  it("does not treat -- inside node text or strings as an edge", () => {
    const src = [
      "flowchart TD",
      '  A["uses --force"] --> B',
      "  C[no / --force] --> D",
      "  E -- ok --> F[still --force]",
    ].join("\n")
    expect(quoteMermaidEdgeLabels(src)).toBe(
      [
        "flowchart TD",
        '  A["uses --force"] --> B',
        "  C[no / --force] --> D",
        '  E -- "ok" --> F[still --force]',
      ].join("\n")
    )
  })

  it("does not rewrite comments or sequence-diagram arrows", () => {
    const src = [
      "sequenceDiagram",
      "  Alice->>Bob: pass --force",
      "  %% A -- no / --force --> B",
    ].join("\n")
    expect(quoteMermaidEdgeLabels(src)).toBe(src)
  })

  it("quotes two labeled edges on one line, nearest closer first", () => {
    expect(quoteMermaidEdgeLabels("A -- x --> B -- y --> C")).toBe(
      'A -- "x" --> B -- "y" --> C'
    )
    expect(quoteMermaidEdgeLabels("A -- x --> B --- C")).toBe('A -- "x" --> B --- C')
  })

  it("preserves CRLF and a trailing newline", () => {
    expect(quoteMermaidEdgeLabels("A -- x --> B\r\n")).toBe('A -- "x" --> B\r\n')
  })
})
