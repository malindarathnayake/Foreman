// Foreman design gauntlet (installed by claude_workflows_init; Claude Code host only).
//
// A design goes in as a brief; an attack-tested design comes out. Research (web sweeps per
// topic plus repository grounding), one hardened design, a three-way attack in parallel
// (the Codex CLI adversarially and read-only, a SOC lens on detection, alerting,
// investigation and containment, and an over-complexity lens), one independent verifier
// per finding, then a completeness critic. The pit-boss deliberates the result in the main
// loop and the USER arbitrates; nothing in the repository changes until they approve.
// The gauntlet never writes the ledger and never counts as a gate seat: the Codex attack
// runs inside a workflow agent, not through invoke_advisor, so its record is stage 'fan'.
//
// args: {
//   repo: string                absolute repository path the attackers and verifiers read
//   out_dir: string             absolute directory for <slug>-design.md and <slug>-codex.md
//   slug: string                short kebab name used in file names
//   brief: string               current architecture, decisions already made, open options, constraints
//   research_context: string    SHORT stable summary used in every research prompt; keep it unchanged
//                               across relaunches so research resumes from cache
//   topics: [{ key, q }]        3-6 research questions
//   grounding: string           what the grounding agent must read and map, with file paths
//   design_requirements: string what the design must cover and decide
//   attack_focus: string        what the attackers must specifically try to break
//   lenses?: string[]           subset of ['codex', 'soc', 'complexity']; default all three
//   model_design?: string       design model; default 'fable', falls back to the host model if refused
//   codex_model?: string        default 'gpt-6-astra'
//   codex_effort?: string       default 'xhigh'
//   max_verifiers?: number      cap on per-finding verifiers; default 30, highest severity first
// }
export const meta = {
  name: 'foreman-design-gauntlet',
  description: 'Foreman design gauntlet: research, hardened design, Codex + SOC + complexity attack, per-finding verification',
  phases: [
    { title: 'Research', detail: 'web sweeps per topic + repository grounding' },
    { title: 'Design', detail: 'one hardened design written to out_dir' },
    { title: 'Attack', detail: 'Codex CLI adversarial + SOC lens + over-complexity lens, in parallel' },
    { title: 'Verify', detail: 'one independent verifier per finding + completeness critic' },
  ],
}

const A = args || {}
for (const k of ['repo', 'out_dir', 'slug', 'brief', 'research_context', 'grounding', 'design_requirements', 'attack_focus']) {
  if (!A[k]) throw new Error(`foreman-design-gauntlet needs args.${k} (see the args block at the top of the script)`)
}
if (!Array.isArray(A.topics) || A.topics.length === 0) throw new Error('foreman-design-gauntlet needs args.topics: [{ key, q }, ...] (3-6)')
const TOPICS = A.topics.slice(0, 6)
const DESIGN_MODEL = A.model_design || 'fable'
const LENSES = A.lenses && A.lenses.length ? A.lenses : ['codex', 'soc', 'complexity']
const CODEX_MODEL = A.codex_model || 'gpt-6-astra'
const CODEX_EFFORT = A.codex_effort || 'xhigh'
const MAX_VERIFIERS = A.max_verifiers || 30
const DESIGN_PATH = `${A.out_dir}/${A.slug}-design.md`
const CODEX_PATH = `${A.out_dir}/${A.slug}-codex.md`
const SEARCH_TOOLS =
  `Use the Perplexity MCP tools if they load (ToolSearch "select:mcp__perplexity__perplexity_research,mcp__perplexity__perplexity_search,mcp__perplexity__perplexity_ask"); ` +
  `otherwise use WebSearch and WebFetch, and say which you used.`

const RESEARCH = {
  type: 'object',
  properties: {
    topic: { type: 'string' }, tool_used: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      idea: { type: 'string' }, detail: { type: 'string' }, applies_how: { type: 'string' },
      source_url: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
      required: ['idea', 'detail', 'applies_how', 'confidence'] } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['topic', 'findings', 'risks'],
}

phase('Research')
const [research, grounding] = await Promise.all([
  parallel(TOPICS.map((t) => () => agent(
    `You are a research scout. ${SEARCH_TOOLS} Investigate:\n\n${t.q}\n\nContext:\n${A.research_context}\n\n` +
    `Return concrete, sourced ideas that could make the design better or safer, and risks. Cite URLs. ` +
    `Mark anything you cannot source as low confidence. No filler.`,
    { label: `research:${t.key}`, phase: 'Research', schema: RESEARCH }))),
  agent(`Ground a design review in the repository at ${A.repo}. ${A.grounding}\nReturn a compact factual map with file:line references. No opinions.`,
    { label: 'grounding:repo', phase: 'Research' }),
])
const researchOk = research.filter(Boolean)
if (researchOk.length < TOPICS.length) log(`research: only ${researchOk.length}/${TOPICS.length} topics returned; the design sees the rest as missing`)

phase('Design')
const DESIGN_PROMPT =
  `You are the design lead. Produce a hardened design as a Markdown document.\n\n## Brief\n${A.brief}\n\n## Repository grounding\n${grounding}\n\n` +
  `## Research\n${JSON.stringify(researchOk, null, 1)}\n\n## The design must\n${A.design_requirements}\n\n` +
  `Rules: read the engineering ethos at ~/.claude/engineering-ethos.md if it exists and declare a proportionality tier (standard/hot/extreme). ` +
  `Keep every decision the brief says is already made; improve where the research shows a better way and say what you changed and why, ` +
  `citing the research; tag security points with [CWE-###] and, where AI-specific, MITRE ATLAS and OWASP LLM / Agentic ids; state what is ` +
  `decided vs proposed; end with a numbered list of open decisions for the user.\nWrite the document to ${DESIGN_PATH} and return the full Markdown.`
let designModel = DESIGN_MODEL
let design = await agent(DESIGN_PROMPT, { label: `design:${DESIGN_MODEL}`, phase: 'Design', model: DESIGN_MODEL })
if (!design) {
  log(`design: model '${DESIGN_MODEL}' returned nothing; retrying on the host model`)
  designModel = 'host'
  design = await agent(DESIGN_PROMPT, { label: 'design:host', phase: 'Design' })
}
if (!design) throw new Error('foreman-design-gauntlet: the design stage returned nothing on both models; nothing to attack')

phase('Attack')
const FINDINGS = {
  type: 'object',
  properties: {
    ran: { type: 'boolean' }, model_header: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
      title: { type: 'string' }, location: { type: 'string' }, scenario: { type: 'string' }, fix: { type: 'string' },
      speculative: { type: 'boolean' }, sources: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'severity', 'title', 'location', 'scenario'] } },
  },
  required: ['ran', 'findings'],
}
const SOC_PROMPT =
  `You are a senior SOC (security operations) lead reviewing a design BEFORE it is built. Read ${DESIGN_PATH} and the repository at ${A.repo}.\n` +
  `Attack it from the SOC seat: for each plausible attack or misuse of this design, can the SOC (1) DETECT it (which log, field and event, ` +
  `with what trace/correlation id across every hop), (2) ALERT on it (a concrete rule: source, condition, threshold, severity, owner), ` +
  `(3) INVESTIGATE it (is the evidence retained long enough, tamper-evident, and free of secrets and personal data), and (4) CONTAIN it ` +
  `(which kill switch, how fast, who can pull it, is it tested)? Also check: logging that leaks secrets or personal data [CWE-532], ` +
  `missing audit of security-relevant changes, unbounded tag-value cardinality, alert fatigue, blind spots between components, and whether ` +
  `the SOC can tell an attack from normal use. Map detections to MITRE ATT&CK and, for AI-specific abuse, MITRE ATLAS technique names where ` +
  `you are confident.\nAttack focus from the brief: ${A.attack_focus}\n` +
  `Be adversarial: report only gaps a skeptical reviewer would accept, each with severity (CRITICAL/HIGH/MEDIUM/LOW), location, the ` +
  `concrete undetected-attack scenario, and the fix (the log field, alert rule or runbook step to add). No praise, no filler. ` +
  `Use ids SOC-1, SOC-2, ... Set ran=true and model_header="claude:soc-lens".`
const CX_PROMPT =
  `You are a ruthless simplicity reviewer. Read ${DESIGN_PATH} and the repository at ${A.repo}. Attack the design for being OVERLY ` +
  `COMPLEX. For every component, store, key, service, table, tool, state, config switch and process step, ask: which concrete ` +
  `requirement or threat does it serve, and what is lost if it is removed or merged? Flag anything that serves no stated requirement, ` +
  `duplicates another guarantee, solves a hypothetical (YAGNI), adds an operational burden (another stateful service, another secret to ` +
  `rotate, another deploy) out of proportion to its value, or could be replaced by an existing mechanism in the repo. Count the moving ` +
  `parts before and after your proposal. Do NOT propose removing something whose removal loses a security or correctness guarantee; ` +
  `say which guarantee each item protects. For each finding: severity (HIGH = major complexity for little value, MEDIUM, LOW), location, ` +
  `what to remove or merge, the guarantee check, and the simpler alternative. End with one paragraph: the simplest design that still ` +
  `meets every stated requirement. Use ids CX-1, CX-2, ... Set ran=true and model_header="claude:complexity-lens".`
const CODEX_PROMPT =
  `Run the Codex CLI as an adversarial reviewer of a design document, then return its findings as structured data.\n\n` +
  `1. Make sure ${DESIGN_PATH} exists; if it does not, write this design into it first:\n\n${design}\n\n` +
  `2. Run exactly this with the Bash tool (timeout 600000 ms, working directory ${A.repo}):\n` +
  `codex exec --skip-git-repo-check -s read-only -m ${CODEX_MODEL} -c model_reasoning_effort="${CODEX_EFFORT}" -o "${CODEX_PATH}" "$(cat <<'FOREMAN_GAUNTLET_EOF'\n` +
  `Review the design at ${DESIGN_PATH}. Ground every claim in the repository at ${A.repo}.\n${A.attack_focus}\n` +
  `Be adversarial. Assume this design contains flaws and your job is to find them. Actively try to BREAK it: construct concrete failure ` +
  `scenarios (inputs, state, timing) that produce wrong output, security or privacy failures, data loss, or platform-policy rejection. ` +
  `Attack edge cases, races, error paths, config drift and interactions with the existing system outside the new design. Do not praise, ` +
  `do not summarize, no style nits. For each finding: severity (CRITICAL/HIGH/MEDIUM/LOW), location (design section or file:line), the ` +
  `concrete failure scenario, and a fix. Label any platform or library claim you cannot back with documentation as SPECULATIVE with a ` +
  `confidence %. If after a genuine attack you find nothing at a severity, say so explicitly.\nFOREMAN_GAUNTLET_EOF\n)" < /dev/null\n\n` +
  `3. Read ${CODEX_PATH} and convert every finding into the schema (ids F1, F2, ...), keeping cited URLs in sources. Put the model and ` +
  `reasoning header Codex printed in model_header; it must name ${CODEX_MODEL} and ${CODEX_EFFORT}. If Codex fails (not installed, auth, ` +
  `model refused), set ran=false and put the error text in model_header. Never invent findings.`

const lens = (label, prompt) => agent(prompt, { label, phase: 'Attack', schema: FINDINGS })
const [codex, soc, cx] = await Promise.all([
  LENSES.includes('codex') ? lens('attack:codex', CODEX_PROMPT) : null,
  LENSES.includes('soc') ? lens('attack:soc', SOC_PROMPT) : null,
  LENSES.includes('complexity') ? lens('attack:complexity', CX_PROMPT) : null,
])
if (codex && !codex.ran) log(`codex did not run: ${codex.model_header || 'no detail'}`)
if (!codex && LENSES.includes('codex')) log('codex lens returned nothing')
if (!soc && LENSES.includes('soc')) log('SOC lens returned nothing')
if (!cx && LENSES.includes('complexity')) log('complexity lens returned nothing')

phase('Verify')
const VERDICT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    classification: { type: 'string', enum: ['AGREE', 'AGREE_DOWNGRADE', 'AGREE_UPGRADE', 'DISAGREE', 'NUANCE', 'UNVERIFIED'] },
    severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'SKIP'] },
    tags: { type: 'string', description: 'CWE / ATLAS / OWASP ids that apply, or empty' },
    reasoning: { type: 'string' }, evidence: { type: 'string' },
  },
  required: ['id', 'classification', 'severity', 'reasoning', 'evidence'],
}
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const src = (r, name) => ((r && r.findings) || []).map((f) => ({ ...f, source: name }))
const findings = [...src(codex, 'codex'), ...src(soc, 'soc'), ...src(cx, 'complexity')]
const toVerify = [...findings].sort((a, b) => (RANK[a.severity] ?? 4) - (RANK[b.severity] ?? 4)).slice(0, MAX_VERIFIERS)
if (toVerify.length < findings.length) log(`verify: ${findings.length - toVerify.length} lowest-severity findings not verified (max_verifiers ${MAX_VERIFIERS})`)
const LENS_NOTE = {
  codex: '',
  soc: 'This is a SOC-lens finding: verify the detection, alerting, investigation or containment gap is real (the log, field or rule ' +
       'really is missing from the design and the repository), not already covered elsewhere.\n',
  complexity: 'This is an over-complexity finding: verify the component really serves no stated requirement, and that removing or ' +
              'merging it loses NO security or correctness guarantee. If it does lose one, classify DISAGREE and name the guarantee.\n',
}
// Every finding gets exactly one verification record, keyed by its position (ref) because ids may repeat.
// A selected verifier that returns nothing, throws, returns a result that breaks the VERDICT schema,
// answers for a different id, or itself classifies the finding UNVERIFIED is NOT a verification: the
// finding stays unverified and says why. Verifier labels carry the ref so they stay unique whatever the ids.
const idCounts = findings.reduce((m, f) => m.set(f.id, (m.get(f.id) || 0) + 1), new Map())
const duplicateIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id)
const checkVerdict = (f, v) => {
  if (v == null) return { status: 'empty', detail: 'verifier returned nothing' }
  if (typeof v !== 'object' || Array.isArray(v)) return { status: 'malformed', detail: `verifier returned ${Array.isArray(v) ? 'an array' : typeof v}` }
  const bad = Object.keys(VERDICT.properties)
    .filter((k) => (VERDICT.required.includes(k) || v[k] !== undefined) && typeof v[k] !== 'string')
  for (const k of ['classification', 'severity']) {
    if (typeof v[k] === 'string' && !VERDICT.properties[k].enum.includes(v[k])) bad.push(`${k}=${v[k]}`)
  }
  if (bad.length) return { status: 'malformed', detail: `invalid or missing: ${bad.join(', ')}` }
  if (v.id !== f.id) return { status: 'mismatched', detail: `verdict is for ${v.id}, not ${f.id}` }
  if (v.classification === 'UNVERIFIED') return { status: 'unverified', verdict: v, detail: 'verifier could not confirm or refute it' }
  return { status: 'verified', verdict: v }
}
const results = await parallel(toVerify.map((f) => async () => {
  try { return checkVerdict(f, await agent(
  LENS_NOTE[f.source] +
  `Independently verify one adversarial finding against a design and the repository. Do not trust the finding's characterisation.\n\n` +
  `Design: ${DESIGN_PATH}. Repository: ${A.repo}.\n\nFinding ${f.id} (${f.severity}): ${f.title}\nLocation: ${f.location}\n` +
  `Scenario: ${f.scenario}\nProposed fix: ${f.fix || ''}\nSources: ${(f.sources || []).join(' ')}\n\n` +
  `Read the design section and every referenced file. Trace the execution path; do not pattern-match. Check whether the design or code ` +
  `already documents and handles the case. Platform claims need documentation (${SEARCH_TOOLS}) or are UNVERIFIED. ` +
  `Severity: CRITICAL = data loss, cross-tenant leak or failed erasure in production; HIGH = likely under load or edge cases; ` +
  `MEDIUM = limited blast radius; LOW = maintainability; SKIP = style. Classify, give your own severity, tag CWE/ATLAS/OWASP ids where ` +
  `they apply, and cite evidence (file:line, design section or URL).`,
  { label: `verify:${findings.indexOf(f)}:${f.id}`, phase: 'Verify', schema: VERDICT })) }
  catch (e) { return { status: 'failed', detail: `verifier failed: ${String((e && e.message) || e).slice(0, 300)}` } }
}))
const verification = findings.map((f, ref) => {
  const i = toVerify.indexOf(f)
  const r = i < 0 ? { status: 'not_selected', detail: `beyond max_verifiers ${MAX_VERIFIERS}` }
    : results[i] || { status: 'failed', detail: 'the host returned no result for this verifier' }
  return { ref, id: f.id, source: f.source, severity: f.severity, status: r.status, ...(r.detail ? { detail: r.detail } : {}) }
})
// verdicts keeps every well-formed answer for its own finding, including UNVERIFIED ones; only status
// 'verified' counts as coverage.
const verdicts = toVerify.flatMap((f, i) => results[i] && results[i].verdict
  ? [{ ...results[i].verdict, source: f.source, ref: findings.indexOf(f) }] : [])
const STATUSES = ['verified', 'unverified', 'empty', 'failed', 'malformed', 'mismatched', 'not_selected']
const verificationSummary = { findings: findings.length, selected: toVerify.length }
for (const s of STATUSES) verificationSummary[s] = verification.filter((v) => v.status === s).length
const gaps = STATUSES.slice(1).filter((s) => verificationSummary[s]).map((s) => `${s} ${verificationSummary[s]}`)
log(`verify: ${verificationSummary.verified}/${findings.length} findings verified${gaps.length ? `; unverified: ${gaps.join(', ')}` : ''}`)
if (duplicateIds.length) log(`verify: duplicate finding ids ${duplicateIds.join(', ')}; use ref (finding index) to tell them apart`)

const critic = await agent(
  `Completeness critic. A design (${DESIGN_PATH}) was attacked by ${LENSES.join(', ')} lenses. Verification coverage: ` +
  `${verificationSummary.verified} of ${findings.length} findings were independently verified (a well-formed verdict for that finding, not UNVERIFIED)` +
  `${gaps.length ? `; the rest are UNVERIFIED (${gaps.join(', ')}) and must not be treated as checked` : ''}.` +
  `${duplicateIds.length ? ` Finding ids repeat (${duplicateIds.join(', ')}); ref is the finding index.` : ''} Findings: ` +
  `${JSON.stringify(verification.map((v) => ({ ref: v.ref, id: v.id, severity: v.severity, title: findings[v.ref].title, verification: v.status })))}. ` +
  `Read the design. What did nobody check? ` +
  `List up to 6 concrete gaps (threat, failure mode, policy or operational issue) with the design section each belongs to, one sentence ` +
  `each, tagged [CWE-###] where security-related. Plain text.`,
  { label: 'critic', phase: 'Verify' })

return {
  design_path: DESIGN_PATH, codex_path: CODEX_PATH, design_model: designModel, design,
  research: researchOk, grounding,
  codex: codex ? { ran: codex.ran, model_header: codex.model_header } : null,
  soc_count: soc ? soc.findings.length : null, complexity_count: cx ? cx.findings.length : null,
  findings, verdicts, verification, verification_summary: verificationSummary, duplicate_ids: duplicateIds,
  unverified_ids: verification.filter((v) => v.status !== 'verified').map((v) => v.id), critic,
  stage: 'fan',
  next: 'Deliberate in the main loop: re-read cited lines for every CRITICAL/HIGH and every DISAGREE, treat every unverified_ids ' +
        'finding as unverified (verification[].status says why), tag kept findings [CWE-###], ' +
        'separate SOC readiness and Simplify tables, list design changes the research drove, carry open decisions to the user. ' +
        'Nothing in the repository changes until the user approves.',
}
