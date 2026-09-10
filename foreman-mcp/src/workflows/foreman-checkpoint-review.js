// Foreman checkpoint review fan (installed by claude_workflows_init; Claude Code host only).
//
// One finder per risk lens over the changed files, a dedup across lenses, then an
// adversarial verify of every finding by two distinct lenses. Returns a record_review-ready
// report. This is PERSPECTIVE, not independence: every agent runs on the host's own model,
// so the pit-boss records it with stage:'fan' and it never counts as a gate seat. External
// advisor seats through invoke_advisor still satisfy the gate.
//
// args: { phase: string, files: string[], spec_excerpt?: string, lenses?: string[] }
export const meta = {
  name: 'foreman-checkpoint-review',
  description: 'Foreman checkpoint review fan: one finder per risk lens, adversarial verify, one report',
  phases: [
    { title: 'Find', detail: 'one read-only finder per risk lens' },
    { title: 'Verify', detail: 'two lenses refute every finding' },
    { title: 'Report', detail: 'merge, classify, list what was examined' },
  ],
}

const LENS_CATALOG = {
  contract: 'public contracts and interfaces: signatures, error semantics, compatibility with callers',
  architecture: 'boundaries, layering, coupling, and whether the change belongs where it landed',
  state: 'state and concurrency: ordering, races, partial writes, idempotency, recovery',
  security: 'trust boundaries, input validation, secrets, injection, authorization; prefix findings [CWE-###]',
  data: 'data integrity: schema, migrations, bounds, retention, corruption paths',
  tests: 'test evidence: does the suite observe the production behaviour; gaps, tautologies, mocks that hide defects',
  operability: 'telemetry, failure visibility, limits, operator surprises',
}

if (!args || !args.phase || !Array.isArray(args.files) || args.files.length === 0) {
  throw new Error('foreman-checkpoint-review needs args { phase, files: [...], spec_excerpt?, lenses? }')
}
const lenses = (args.lenses && args.lenses.length ? args.lenses : ['contract', 'state', 'security', 'tests']).filter((l) => LENS_CATALOG[l])
if (lenses.length < 2) throw new Error('choose at least two lenses from: ' + Object.keys(LENS_CATALOG).join(', '))
const files = args.files.slice(0, 40)
const spec = args.spec_excerpt ? `\nSPEC EXCERPT\n${String(args.spec_excerpt).slice(0, 12000)}` : ''

const FINDINGS = {
  type: 'object',
  properties: {
    completion: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    checked: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      file: { type: 'string' }, line: { type: 'string' }, description: { type: 'string' } },
      required: ['severity', 'file', 'line', 'description'] } },
    limitations: { type: 'string' },
  },
  required: ['completion', 'checked', 'findings', 'limitations'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    evidence: { type: 'string' }, checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['refuted', 'severity', 'evidence', 'checked'],
}

phase('Find')
const found = (await parallel(lenses.map((lens) => () => agent(
  `You are one adversarial reviewer in a Foreman checkpoint review for phase '${args.phase}'. Your ONLY lens: ${lens} — ${LENS_CATALOG[lens]}. Findings from other lenses are noise here.
Open these files and cite file:line for every finding from code you actually read; never invent a symbol or line. Severity is blast radius, not confidence. Do not report style. Zero findings is valid but you must still list what you examined in checked[]; silence without that list is a failed review. Do not write files.
FILES: ${files.join(', ')}${spec}`,
  { label: `find:${lens}`, phase: 'Find', schema: FINDINGS })))).filter(Boolean)

const key = (f) => `${f.file.replace(/\\/g, '/')}:${f.line}:${f.description.slice(0, 60).toLowerCase()}`
const seen = new Map()
for (const r of found) for (const f of r.findings) if (!seen.has(key(f))) seen.set(key(f), f)
const candidates = [...seen.values()].slice(0, 30)
log(`${found.length}/${lenses.length} finders complete; ${candidates.length} distinct findings`)

phase('Verify')
const verified = await parallel(candidates.map((f) => () =>
  parallel(['correctness', 'reproduce'].map((angle) => () => agent(
    `Try to REFUTE this review finding for Foreman phase '${args.phase}' from the ${angle} angle. Open the cited code. ${angle === 'reproduce' ? 'Describe the concrete input or sequence that triggers it, or show it cannot be triggered.' : 'Show whether the code actually behaves as claimed.'} Default to refuted=true when uncertain. Re-rate severity by blast radius. List what you checked.
FINDING: [${f.severity}] ${f.file}:${f.line} — ${f.description}`,
    { label: `verify:${f.file.split(/[\\/]/).pop()}:${angle}`, phase: 'Verify', schema: VERDICT }))
  ).then((vs) => ({ f, votes: vs.filter(Boolean) }))))

phase('Report')
const findings = verified.map(({ f, votes }) => {
  const refutations = votes.filter((v) => v.refuted).length
  const classification = votes.length === 0 ? 'unverified' : refutations === 0 ? 'confirmed' : refutations === votes.length ? 'rejected' : 'unverified'
  const severity = votes.length ? votes.map((v) => v.severity).sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a) - ['critical', 'high', 'medium', 'low'].indexOf(b))[0] : f.severity
  return { severity, file: f.file, line: String(f.line), description: f.description, classification, evidence: votes.map((v) => v.evidence).join(' | ') }
})
const checked = [...new Set([...found.flatMap((r) => r.checked), ...verified.flatMap(({ votes }) => votes.flatMap((v) => v.checked))])].slice(0, 50)
const incomplete = found.filter((r) => r.completion !== 'complete').length + (lenses.length - found.length)
return {
  advisor: 'claude-workflow-fan',
  stage: 'fan',
  completion: incomplete === 0 ? 'complete' : 'partial',
  lenses,
  checked,
  findings,
  limitations: `Same-model review fan on the host model via the Workflow tool; perspective, not cross-vendor independence; never a gate seat. ${incomplete} lens(es) incomplete. ` + found.map((r) => r.limitations).filter(Boolean).join(' '),
}
