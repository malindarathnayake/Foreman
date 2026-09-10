// Foreman field-report triage (installed by claude_workflows_init; Claude Code host only).
//
// Every report is verified against the code before it is believed, a fix is designed for
// each confirmed one, and each design is attacked. Implementation is NOT part of this
// workflow: the pit-boss implements through Foreman's unit protocol so every change gets
// its ledger record, guard cycle and verdict. The output is a ranked triage with specs.
//
// args: { reports: string[], repo?: string }
export const meta = {
  name: 'foreman-triage',
  description: 'Foreman field-report triage: verify each report in code, design a fix, attack the design',
  phases: [
    { title: 'Verify', detail: 'confirm or reject each report against the code' },
    { title: 'Design', detail: 'one fix spec per confirmed report' },
    { title: 'Attack', detail: 'gaming and integrity lenses per design' },
  ],
}

if (!args || !Array.isArray(args.reports) || args.reports.length === 0) throw new Error('foreman-triage needs args { reports: [...], repo? }')
const reports = args.reports.slice(0, 12).map((r, i) => ({ id: `R${i + 1}`, text: String(r) }))
const repo = args.repo ? `REPOSITORY: ${args.repo}\n` : ''

const VERIFY = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['confirmed', 'rejected', 'unverified'] },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'skip'] },
    evidence: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' } }, required: ['claim', 'file', 'line'] } },
    root_cause: { type: 'string' },
  },
  required: ['status', 'severity', 'evidence', 'root_cause'],
}
const DESIGN = {
  type: 'object',
  properties: {
    change_spec: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } }, legacy_behaviour: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['change_spec', 'files', 'tests', 'legacy_behaviour', 'risks'],
}
const CRITIQUE = {
  type: 'object',
  properties: {
    lens: { type: 'string' }, attacks: { type: 'array', items: { type: 'object', properties: {
      claim: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, evidence: { type: 'string' }, cwe: { type: 'string' }, holds: { type: 'boolean' } },
      required: ['claim', 'severity', 'evidence', 'holds'] } },
    verdict: { type: 'string', enum: ['adopt', 'adopt_with_changes', 'reject'] },
    required_changes: { type: 'array', items: { type: 'string' } },
  },
  required: ['lens', 'attacks', 'verdict', 'required_changes'],
}

const triaged = await pipeline(
  reports,
  (r) => agent(`Verify this field report against the code. Trace the actual execution path; do not pattern-match. Every evidence entry needs file and line from code you opened. Severity: CRITICAL crashes or corrupts, HIGH likely under load or edge cases, MEDIUM limited blast radius, LOW maintainability, SKIP pure style. Name the root cause, which may differ from the reporter's.\n${repo}REPORT ${r.id}: ${r.text}`, { label: `verify:${r.id}`, phase: 'Verify', schema: VERIFY }),
  (v, r) => v && v.status === 'confirmed' ? agent(`Design the fix for this confirmed report. Complete implementable spec: exact predicates, types, NEW messages only (never alter existing messages, they are golden in tests), tests in one sentence each, legacy behaviour, risks. Rules the model cannot argue with live in enforcement code, not prose.\n${repo}REPORT ${r.id}: ${r.text}\nROOT CAUSE: ${v.root_cause}\nEVIDENCE: ${v.evidence.map((e) => `${e.file}:${e.line} ${e.claim}`).join('; ')}`, { label: `design:${r.id}`, phase: 'Design', schema: DESIGN }).then((d) => ({ v, d })) : { v, d: null },
  (x, r) => x && x.d ? parallel(['gaming and regression', 'integrity and implementation'].map((lens) => () => agent(
    `Adversarial lens: ${lens}. Try to break this fix. Can it be gamed, does it reopen something a changelog entry closed, does it change a golden message, is anything unbounded? Open the code and cite lines. An attack the code already prevents does not hold. [CWE-###] on security attacks.\n${repo}REPORT ${r.id}: ${r.text}\nDESIGN\n${x.d.change_spec}`,
    { label: `attack:${r.id}:${lens.split(' ')[0]}`, phase: 'Attack', schema: CRITIQUE }))).then((cs) => ({ ...x, critiques: cs.filter(Boolean) })) : x,
)

const order = ['critical', 'high', 'medium', 'low', 'skip']
const rows = triaged.map((t, i) => ({ report: reports[i], ...t })).filter((t) => t.v)
rows.sort((a, b) => order.indexOf(a.v.severity) - order.indexOf(b.v.severity))
return rows.map((t) => ({
  id: t.report.id, report: t.report.text, status: t.v.status, severity: t.v.severity, root_cause: t.v.root_cause,
  evidence: t.v.evidence.map((e) => `${e.file}:${e.line} — ${e.claim}`),
  design: t.d ? { spec: t.d.change_spec, files: t.d.files, tests: t.d.tests, legacy: t.d.legacy_behaviour, risks: t.d.risks } : null,
  critiques: (t.critiques || []).map((c) => ({ lens: c.lens, verdict: c.verdict, holds: c.attacks.filter((a) => a.holds).map((a) => `[${a.severity}${a.cwe ? ' ' + a.cwe : ''}] ${a.claim}`), required_changes: c.required_changes })),
}))
