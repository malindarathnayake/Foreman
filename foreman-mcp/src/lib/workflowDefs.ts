import { z } from "zod"

// 0.8.0 (2026-10-07): definitions drive native procedures and Claude script parity checks.
export const FOREMAN_WORKFLOWS = ["foreman-checkpoint-review", "foreman-design-panel", "foreman-design-gauntlet", "foreman-triage"] as const
export type ForemanWorkflow = (typeof FOREMAN_WORKFLOWS)[number]
export type WorkflowRole = "explorer" | "reviewer" | "verifier" | "design" | "advisor"
export type WorkflowArgs = Record<string, unknown>
export interface WorkflowTask {
  id: string
  role: WorkflowRole
  source: string
  count: (args: WorkflowArgs) => [number, number]
  cap: number
  prompt: string
  result: z.ZodType
}
export interface WorkflowDefinition {
  name: ForemanWorkflow
  description: string
  args: z.ZodObject
  phases: Array<{ title: string; tasks: WorkflowTask[] }>
  invariants: typeof WORKFLOW_INVARIANTS
  finish: string
}
export const WORKFLOW_INVARIANTS = {
  never_implements: true,
  never_writes_ledger: true,
  record_stage: "fan",
  user_arbitrates: true,
} as const

const text = z.string().trim().min(1)
const strings = z.array(text)
const severity = z.enum(["critical", "high", "medium", "low"])
const completion = z.enum(["complete", "partial", "failed"])
const finding = z.object({ id: text, severity, location: text, claim: text, evidence: text, source: text })
const recordedFinding = z.object({ severity, file: z.string().max(4096), line: z.string().max(20), description: z.string().max(10000), classification: z.enum(["confirmed", "rejected", "unverified"]) })
const findings = z.object({ completion, checked: strings.min(1), findings: z.array(finding), limitations: z.string() })
const verdict = z.object({ id: text, classification: z.enum(["confirmed", "rejected", "unverified"]), severity, evidence: text, checked: strings.min(1) })
const critique = z.object({ lens: text, attacks: z.array(finding.extend({ holds: z.boolean() })), verdict: z.enum(["adopt", "adopt_with_changes", "reject"]), required_changes: strings })
const design = z.object({ design: text, proportionality_tier: z.enum(["standard", "hot", "extreme"]), risks: strings, open_decisions: strings })
const fixed = (n: number) => (_args: WorkflowArgs): [number, number] => [n, n]
const length = (args: WorkflowArgs, field: string, fallback: number) => Array.isArray(args[field]) ? args[field].length : fallback
const sized = (field: string, fallback: number, factor = 1) => (args: WorkflowArgs): [number, number] => {
  const n = length(args, field, fallback) * factor
  return [n, n]
}
const task = (id: string, role: WorkflowRole, source: string, count: WorkflowTask["count"], cap: number, prompt: string, result: z.ZodType): WorkflowTask => ({ id, role, source, count, cap, prompt, result })
export const PANEL_STANCES = ["simplest thing that could work; minimise new concepts", "risk-first; assume the worst input and the worst operator", "measure-first; do not change behaviour until the data exists to judge it"]
export const CHECKPOINT_LENSES = ["contract", "architecture", "state", "security", "data", "tests", "operability"] as const

export const WORKFLOW_DEFS: Record<ForemanWorkflow, WorkflowDefinition> = {
  "foreman-design-panel": {
    name: "foreman-design-panel",
    description: "Independent design stances, two attack lenses each, one synthesis with conflicts for user arbitration.",
    args: z.strictObject({ question: text, context: text.optional(), stances: strings.min(1).max(5).default(PANEL_STANCES), files: strings.max(30).optional() }),
    invariants: WORKFLOW_INVARIANTS,
    phases: [
      { title: "Propose", tasks: [task("proposals", "design", "one per args.stances", sized("stances", 3), 5,
        "Independently propose a complete design for args.question from your assigned stance. Read args.files and args.context. Declare the engineering ethos proportionality tier; state your thesis, risks and what you give up. Do not see other proposals.",
        design.extend({ title: text, stance: text, thesis: text, gives_up: text }))] },
      { title: "Attack", tasks: [task("attacks", "reviewer", "two per proposals item: gaming and failure modes; implementation and maintenance cost", sized("stances", 3, 2), 6,
        "Attack only your assigned proposal through your assigned lens. Re-open the named code. Set holds=true only with an evidenced failure path; show what would refute it.", critique)] },
      { title: "Synthesize", tasks: [task("synthesis", "verifier", "one over all proposals and attacks", fixed(1), 1,
        "Re-open evidence for attacks you rely on. Weigh whether attacks hold, not their count. Produce one complete recommendation from surviving ideas. Preserve every genuine conflict, both positions, your lean and why the user decides; list rejected ideas and unverified claims.",
        z.object({ recommendation: text, conflicts: z.array(z.object({ topic: text, position_a: text, position_b: text, lean: text, why_user_decides: text })), rejected: strings, unverified: strings }))] },
    ],
    finish: "Return the synthesis and each proposal's stance and attack verdicts. Present unresolved conflicts to the user; do not implement the recommendation.",
  },
  "foreman-checkpoint-review": {
    name: "foreman-checkpoint-review",
    description: "Phase checkpoint review fan with one finder per risk lens, two verifiers per finding and one report.",
    args: z.strictObject({ phase: text, files: strings.min(1).max(40), spec_excerpt: text.optional(), lenses: z.array(z.enum(CHECKPOINT_LENSES)).min(2).max(7).default(["contract", "state", "security", "tests"]) }),
    invariants: WORKFLOW_INVARIANTS,
    phases: [
      { title: "Find", tasks: [task("findings", "reviewer", "one per args.lenses", sized("lenses", 4), 6,
        "Review args.files for args.phase against args.spec_excerpt, through ONLY your assigned lens. Cite actual file:line evidence. Severity is blast radius; omit style. Zero findings is valid only with a non-empty checked list. Deduplicate returned findings by location and claim before Verify; retain at most 30, highest severity first, and list overflow as unverified.", findings)] },
      { title: "Verify", tasks: [task("verdicts", "verifier", "two per deduplicated findings item (up to 30): correctness; reproduce", () => [0, 60], 6,
        "Try to refute your assigned finding by opening the cited code. In the reproduce lens describe a concrete trigger or why it cannot occur; in the correctness lens trace actual behavior. Classify uncertainty as unverified, never confirmation. Return your own severity and evidence.", verdict)] },
      { title: "Report", tasks: [task("report", "verifier", "one over findings and both verdicts per finding", fixed(1), 1,
        "Merge duplicates and checked lists. Confirm only when BOTH verifiers confirm; reject only when BOTH reject; otherwise classify unverified. Missing, failed or partial finders/verifiers and overflow make completion partial. Preserve every finding and limitation. Convert locations to file and line (string), claims and verification evidence to description. Return advisor='workflow-fan' and stage='fan'; this is perspective, never a gate seat. If over 100 findings remain, return overflow separately and mark the report partial.",
        z.object({ advisor: z.literal("workflow-fan"), stage: z.literal("fan"), completion, checked: strings.max(50), limitations: z.string().max(2000), findings: z.array(recordedFinding).max(100) }))] },
    ],
    finish: "Return a report ready for a record_review entry with stage: 'fan' (record_review is an operation of the ledger write tool, not a tool of its own). The workflow never writes the ledger; the parent may record the report later through the unit protocol. Never substitute this fan for a gate seat.",
  },
  "foreman-triage": {
    name: "foreman-triage",
    description: "Verify field reports against code, design a fix for each confirmed report and attack each design.",
    args: z.strictObject({ reports: strings.min(1).max(12), repo: text.optional() }),
    invariants: WORKFLOW_INVARIANTS,
    phases: [
      { title: "Verify", tasks: [task("triaged", "verifier", "one per args.reports, assign stable R1, R2, ... IDs", sized("reports", 12), 6,
        "Verify the assigned field report in args.repo or the current repository. Trace its actual execution path, cite file:line evidence, classify confirmed/rejected/unverified and identify the root cause. Do not trust the reporter's explanation.", verdict.extend({ root_cause: text }))] },
      { title: "Design", tasks: [task("fixes", "design", "one per confirmed triaged item only", (a) => [0, length(a, "reports", 12)], 6,
        "Design an implementable fix for your assigned confirmed report: exact predicates, types, affected files, tests, legacy behavior and risks. Never alter existing golden messages; specify only new messages. Enforcement belongs in code. Return the specification as text without editing files.",
        design.extend({ change_spec: text, files: strings, tests: strings, legacy_behaviour: text }))] },
      { title: "Attack", tasks: [task("critiques", "reviewer", "two per fixes item: gaming and regression; integrity and implementation", (a) => [0, 2 * length(a, "reports", 12)], 6,
        "Try to break the assigned fix through your lens. Check bypasses, regressions, golden messages, reopened changelog issues and unbounded work. Cite code; attacks already prevented do not hold. Tag security attacks [CWE-###].", critique)] },
    ],
    finish: "Return every report ID, classification, severity, evidence and root cause, plus its fix spec and critiques when present. Sort by severity. Preserve rejected and unverified reports. Implementation is NOT part of this workflow; use the unit protocol later.",
  },
  "foreman-design-gauntlet": {
    name: "foreman-design-gauntlet",
    description: "Research and repository grounding, one hardened design, external advisor plus SOC and complexity attacks, per-finding verification and a completeness critic.",
    args: z.strictObject({
      repo: text, out_dir: text, slug: text.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a short kebab name without path separators").max(80),
      brief: text, research_context: text, topics: z.array(z.strictObject({ key: text, q: text })).min(1).max(6), grounding: text,
      design_requirements: text, attack_focus: text, lenses: z.array(z.enum(["codex", "soc", "complexity"])).min(1).max(3).default(["codex", "soc", "complexity"]),
      model_design: text.optional(), codex_model: text.optional(), codex_effort: text.optional(), max_verifiers: z.number().int().min(1).max(30).default(30),
    }),
    invariants: WORKFLOW_INVARIANTS,
    phases: [
      { title: "Research", tasks: [
        task("research", "explorer", "one per args.topics; each uses both research sources", sized("topics", 6), 6,
          "Investigate the assigned topic.q using BOTH Perplexity MCP research/search and Codex web search. Keep args.research_context unchanged across relaunches. Cite primary URLs, distinguish sourced facts from inference and record which tools ran. If a source is unavailable, including Codex web search on Cursor, report the missing source and mark coverage partial; never silently claim both ran or substitute another source.",
          z.object({ topic: text, completion, tools_used: strings, findings: z.array(z.object({ idea: text, detail: text, applies_how: text, source_url: text, confidence: z.enum(["high", "medium", "low"]) })), risks: strings, limitations: z.string() })),
        task("grounding", "explorer", "one over args.repo", fixed(1), 1,
          "Follow args.grounding in args.repo. Return a factual repository map with actual file:line references, checked paths and limitations. No opinions.", z.object({ map: text, checked: strings.min(1), limitations: z.string() })),
      ] },
      { title: "Design", tasks: [task("design", "design", "one over research and grounding", fixed(1), 1,
        "Produce one complete hardened Markdown design from args.brief, args.design_requirements, research and grounding. Preserve already-made decisions. Declare the engineering ethos proportionality tier, justify research-driven changes with citations, tag security points [CWE-###], separate decided from proposed and list open decisions. Return the complete document to the parent; do not write files.", design)] },
      { title: "Attack", tasks: [
        task("advisor", "advisor", "one if args.lenses includes codex (legacy name for external attack)", (a) => a.lenses && !(a.lenses as string[]).includes("codex") ? [0, 0] : [1, 1], 1,
          "Adversarially attack the supplied design and bounded repository evidence against args.attack_focus. Construct concrete failure scenarios: races, error paths, drift, trust boundaries and interactions. Label unsupported platform claims unverified. Return every finding with stable source-qualified IDs, severity, scenario, evidence and fix. Record the actual CLI, model and receipt. The parent must supply evidence because advisor tools may be disabled.", findings),
        task("local_attacks", "reviewer", "one per enabled args.lenses item soc or complexity", (a) => { const n = ((a.lenses ?? ["codex", "soc", "complexity"]) as string[]).filter((l) => l !== "codex").length; return [n, n] }, 2,
          "Read the complete design and args.repo against args.attack_focus. SOC lens: detection, concrete alert rules/thresholds/owners, investigation evidence retention and correlation, containment and kill switches; identify leaks [CWE-532], blind spots and alert fatigue. Complexity lens: map each moving part to a concrete requirement; propose removal/merging only if NO correctness or security guarantee is lost. Cite evidence and source-qualified finding IDs.", findings),
      ] },
      { title: "Verify", tasks: [
        task("verdicts", "verifier", "one per attack finding, severity sorted, capped by args.max_verifiers; keep overflow unverified", (a) => [0, Number(a.max_verifiers ?? 30)], 6,
          "Independently test the assigned finding against the design, every cited file and actual execution path. Do not trust the attacker's characterization. Check whether the alleged SOC gap is already covered or a simplification loses a guarantee. Unsupported platform claims remain unverified. Return classification, your own severity and evidence; preserve the source-qualified ID.", verdict),
        task("critic", "reviewer", "one AFTER every verdict over all findings and the design", fixed(1), 1,
          "Completeness critic: read the complete design and all findings/verdicts. List up to six concrete unchecked threats, failure modes, policy or operational gaps, each tied to a design section. Tag security gaps [CWE-###]. These new gaps are unverified until examined.", z.object({ gaps: strings.max(6), limitations: z.string() })),
      ] },
    ],
    finish: "Return design_path, advisor_path, design_model as actually reported, research coverage, grounding, actual advisor CLI/model/receipt, all findings/verdicts, unverified IDs and critic gaps. Deliberate in the main loop: re-read evidence for every critical/high and rejected claim, present SOC readiness and Simplify tables and research-driven design changes. Nothing in the repository changes until the user approves. The aggregate is stage: 'fan'; an invoke_advisor receipt stays separate and is eligible only under the normal gate rules.",
  },
}

export function agentEstimate(def: WorkflowDefinition, args: WorkflowArgs): [number, number] {
  return def.phases.flatMap((p) => p.tasks).reduce<[number, number]>(([lo, hi], t) => {
    const [a, b] = t.count(args)
    return [lo + a, hi + b]
  }, [0, 0])
}
