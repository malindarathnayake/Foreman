// Versioned review-lens catalog for the Adaptive Review Council (docs/0.5.11/DesignConcept.md).
//
// A lens is a COMPACT review perspective with an activation rule and a distinct question —
// not a permanent agent and not a checklist. Design principle 3 ("project only the context a
// reviewer needs") is enforced structurally here: a seat receives the evidence packet plus ONE
// lens card. The concept document, the other lenses, provider details, and experiment-arm
// definitions never enter a reviewer's context.
//
// Cards are deliberately short. If a lens needs a long standing prompt to work, the design doc's
// rule applies: first test whether a stronger broad reviewer or a deterministic boundary check
// solves the problem more reliably, and only then grow the card.
//
// The catalog may grow ONLY when a proposed lens repeatedly finds defects existing lenses do not.
// Bump LENS_CATALOG_VERSION on any card edit — recorded reviews cite it, so a silent card change
// would make two differently-prompted reviews look identical in the ledger.

export const LENS_CATALOG_VERSION = "1"

export const LENS_IDS = [
  "contract",
  "architecture",
  "state",
  "security",
  "data",
  "tests",
  "operability",
] as const

export type LensId = (typeof LENS_IDS)[number]

/** "broad" runs by default and gets the whole packet; "specialist" is added only for a distinct uncovered risk. */
export type BudgetClass = "broad" | "specialist"

export interface LensCard {
  id: LensId
  title: string
  budgetClass: BudgetClass
  /** When the selector should add this lens. Shown to the HOST, never sent to the seat. */
  activateWhen: string
  /** The one question this lens answers that no other lens does. Sent to the seat. */
  question: string
  /** The seat-facing perspective body. Kept to a few lines on purpose. */
  card: string
}

export const LENS_CATALOG: Record<LensId, LensCard> = {
  contract: {
    id: "contract",
    title: "Contract and correctness",
    budgetClass: "broad",
    activateWhen: "Default broad review — always present unless the host explicitly narrows the council.",
    question: "Does the implementation satisfy the accepted contract, including unhappy paths?",
    card: [
      "Review the change against the accepted contract, not against your own preferred design.",
      "Walk the unhappy paths explicitly: empty input, boundary values, error returns, early returns,",
      "partial application, and every branch the happy path does not exercise.",
      "A behavior the contract requires but the diff never implements is a finding. So is a behavior",
      "the diff implements that the contract never asked for.",
    ].join("\n"),
  },
  architecture: {
    id: "architecture",
    title: "Architecture and structure",
    budgetClass: "specialist",
    activateWhen: "Cross-module refactor, new boundary, dependency inversion, or ownership change.",
    question: "Did the change preserve coherent boundaries and dependency direction?",
    card: [
      "Judge boundaries and dependency direction only. Do not restate correctness findings.",
      "Look for: a module that grew a responsibility belonging to another, a dependency that now points",
      "the wrong way, duplicated logic that should have been one seam, and an abstraction introduced",
      "with exactly one caller.",
      "Name the specific boundary that moved and what now depends on what.",
    ].join("\n"),
  },
  state: {
    id: "state",
    title: "State and concurrency",
    budgetClass: "specialist",
    activateWhen: "State machine, retry, queue, transaction, cancellation, stream, or lifecycle change.",
    question: "Are transitions, invariants, re-entry, partial failure, and concurrency safe?",
    card: [
      "TRACE the actual execution path — do not pattern-match on primitive names.",
      "For every concurrency claim, state the interleaving: operation at line X, competing operation at",
      "line Y, and the conflicting state. A claim you cannot sequence line-by-line is not a finding.",
      "Cover: re-entry, cancellation mid-flight, partial failure leaving a half-applied state, retry",
      "without idempotence, and an invariant that holds at entry but not after an early return.",
    ].join("\n"),
  },
  security: {
    id: "security",
    title: "Security and abuse",
    budgetClass: "specialist",
    activateWhen: "Trust boundary, identity, authorization, secret, parser, network, or untrusted-input change.",
    question: "How can an attacker or a compromised dependency misuse this path?",
    card: [
      "Reason as an attacker with the access the change actually grants, not as a checklist.",
      "Name the trust boundary being crossed and the concrete misuse: the input, the path it takes, and",
      "the resulting capability.",
      "Prefix every security finding with its weakness class, e.g. [CWE-79].",
      "Untrusted input includes model output, file contents, and dependency responses — not just user input.",
    ].join("\n"),
  },
  data: {
    id: "data",
    title: "Data integrity and recovery",
    budgetClass: "specialist",
    activateWhen: "Migration, persistence, Git/worktree manipulation, destructive command, or recovery path.",
    question: "Can accepted state be lost, silently replaced, or restored incorrectly?",
    card: [
      "Assume the operation is interrupted at its worst moment and ask what survives.",
      "Look for: a write that is not atomic, a destructive command with no retained recovery artifact,",
      "a migration with no reverse, state replaced rather than merged, and a recovery path that has",
      "never been executed.",
      "Git and worktree manipulation counts as persistence: a reset or stash that discards accepted work",
      "is data loss even when the test suite stays green.",
    ].join("\n"),
  },
  tests: {
    id: "tests",
    title: "Test strength",
    budgetClass: "specialist",
    activateWhen: "High-risk fix, weak regression history, or a broad green-suite claim.",
    question: "Would a realistic mutant or a removed guard still pass?",
    card: [
      "Judge whether the tests would FAIL if the code were wrong. A passing suite is not evidence.",
      "For each significant guard in the diff, name the mutation that would survive: invert the",
      "condition, drop the bound, return early, swallow the error — and say which test catches it.",
      "If none does, that is the finding, and cite the guard's file:line.",
      "Tests that assert on mocks rather than behavior, and tests deleted alongside the code they",
      "covered, are findings.",
    ].join("\n"),
  },
  operability: {
    id: "operability",
    title: "Operability",
    budgetClass: "specialist",
    activateWhen: "Release, deployment, telemetry, timeout, resource, or failure-reporting change.",
    question: "Can operators detect, diagnose, and recover from failure?",
    card: [
      "Assume this fails at 3am for someone who did not write it.",
      "Ask: does the failure surface at all, does the message name the specific cause and the corrective",
      "action, is there an unbounded wait, and is a resource acquired on a path that can skip release.",
      "Telemetry findings must respect the declared contract: bounded tag cardinality, trace correlation,",
      "and no secrets or PII in any signal.",
    ].join("\n"),
  },
}

export function isLensId(value: string): value is LensId {
  return (LENS_IDS as ReadonlyArray<string>).includes(value)
}

/** The lens set used when the host does not name one. Broad-only is the documented default budget. */
export const DEFAULT_LENSES: LensId[] = ["contract"]

/**
 * The output contract every seat must satisfy, appended to each lens card.
 *
 * The adversarial framing lives here rather than in the cards so it cannot drift per lens, and so a
 * card edit is always a perspective change rather than a discipline change. Three rules matter most:
 * an empty finding list must still account for what was examined (silence is not approval); a
 * blocking finding without file evidence is downgraded rather than dropped (the host still sees it);
 * and severity is defined by blast radius, not by how confident the reviewer feels.
 */
export const SEAT_OUTPUT_CONTRACT = [
  "You are an adversarial reviewer on a Foreman review council. Your job is to find the defect that",
  "reaches production, not to summarize the change and not to approve it.",
  "",
  "Evidence rules:",
  "- Cite file:line from the supplied evidence for every finding. A finding you cannot locate in the",
  "  evidence is speculation — either mark its confidence \"low\" or drop it.",
  "- Never invent a file, symbol, or line number that is not in the evidence packet.",
  "- If the evidence is insufficient to answer your lens question, say so in `limitations`. Missing",
  "  evidence is a reportable condition, never a silent pass.",
  "",
  "Severity is blast radius, not confidence:",
  "  critical = crashes, corrupts, or loses data in production",
  "  high     = fails under load or on a realistic edge case; resource leak; unhandled error path",
  "  medium   = correctness issue with limited blast radius",
  "  low      = maintainability or clarity",
  "Do not report pure style preferences at any severity. Do not inflate to be heard.",
  "",
  "If you find nothing, return an empty `findings` array and list in `checked` what you actually",
  "examined. An empty `checked` with no findings will be treated as a failed review, not an approval.",
].join("\n")

/** JSON Schema for the seat response. Sent as response_format.json_schema (strict). */
export const SEAT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["completion", "findings", "limitations", "checked"],
  properties: {
    completion: {
      type: "string",
      enum: ["complete", "partial"],
      description: "\"partial\" when the evidence did not permit a full answer to the lens question.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "description", "confidence"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string", description: "Path from the evidence packet, or \"\" if not locatable." },
          line: { type: "string", description: "Line number as a string, or \"\" if not locatable." },
          description: { type: "string", description: "The defect and the concrete failure it causes." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reproduction: { type: "string", description: "Inputs or state that trigger the defect, if known." },
        },
      },
    },
    limitations: {
      type: "array",
      items: { type: "string" },
      description: "What this review could not establish, and why.",
    },
    checked: {
      type: "array",
      items: { type: "string" },
      description: "What was actually examined. Required when findings is empty.",
    },
  },
} as const

/** Builds the full system prompt for one seat. Pure — same inputs give byte-identical output. */
export function buildSeatPrompt(lens: LensCard): string {
  return [
    SEAT_OUTPUT_CONTRACT,
    "",
    `LENS: ${lens.title} (id: ${lens.id}, catalog v${LENS_CATALOG_VERSION})`,
    `YOUR DISTINCT QUESTION: ${lens.question}`,
    "",
    lens.card,
    "",
    "Answer only your lens question. Findings that belong to another lens are noise here.",
  ].join("\n")
}
