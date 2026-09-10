// Foreman design panel (installed by claude_workflows_init; Claude Code host only).
//
// Independent proposals from distinct stances, each attacked by two lenses, then one
// synthesis that records every genuine conflict for the USER to arbitrate. The engineering
// ethos rule applies: pillar conflicts are recorded and arbitrated, never silently resolved.
// The panel informs design_partner / spec work; it never writes the ledger.
//
// args: { question: string, context?: string, stances?: string[], files?: string[] }
export const meta = {
  name: 'foreman-design-panel',
  description: 'Foreman design panel: independent stances, adversarial attack, synthesis with conflicts for arbitration',
  phases: [
    { title: 'Propose', detail: 'one design per stance' },
    { title: 'Attack', detail: 'two lenses per proposal' },
    { title: 'Synthesize', detail: 'one recommendation plus conflicts' },
  ],
}

if (!args || !args.question) throw new Error('foreman-design-panel needs args { question, context?, stances?, files? }')
const stances = (args.stances && args.stances.length ? args.stances : [
  'simplest thing that could work; minimise new concepts',
  'risk-first; assume the worst input and the worst operator',
  'measure-first; do not change behaviour until the data exists to judge it',
]).slice(0, 5)
const ctx = `QUESTION\n${args.question}\n${args.context ? `\nCONTEXT\n${String(args.context).slice(0, 20000)}` : ''}${args.files && args.files.length ? `\nFILES TO READ FIRST: ${args.files.slice(0, 30).join(', ')}` : ''}`

const PROPOSAL = {
  type: 'object',
  properties: {
    title: { type: 'string' }, stance: { type: 'string' }, thesis: { type: 'string' },
    design: { type: 'string', description: 'complete design in markdown' },
    gives_up: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } },
    proportionality_tier: { type: 'string', enum: ['standard', 'hot', 'extreme'] },
  },
  required: ['title', 'stance', 'thesis', 'design', 'gives_up', 'risks', 'proportionality_tier'],
}
const CRITIQUE = {
  type: 'object',
  properties: {
    lens: { type: 'string' }, attacks: { type: 'array', items: { type: 'object', properties: {
      claim: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, evidence: { type: 'string' }, holds: { type: 'boolean' } },
      required: ['claim', 'severity', 'evidence', 'holds'] } },
    verdict: { type: 'string', enum: ['adopt', 'adopt_with_changes', 'reject'] },
  },
  required: ['lens', 'attacks', 'verdict'],
}
const SYNTH = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', description: 'complete recommended design, markdown' },
    conflicts: { type: 'array', items: { type: 'object', properties: {
      topic: { type: 'string' }, position_a: { type: 'string' }, position_b: { type: 'string' }, lean: { type: 'string' }, why_user_decides: { type: 'string' } },
      required: ['topic', 'position_a', 'position_b', 'lean', 'why_user_decides'] } },
    rejected: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['recommendation', 'conflicts', 'rejected', 'unverified'],
}

const results = await pipeline(
  stances,
  (stance, _s, i) => agent(`You are one of ${stances.length} independent designers. Your stance: ${stance}. Read the engineering ethos at ~/.claude/engineering-ethos.md if it exists and declare a proportionality tier. Produce a complete design from your stance; ground claims in the code when files are named; state plainly what you give up. Do not hedge toward other stances.\n${ctx}`, { label: `propose:${i + 1}`, phase: 'Propose', schema: PROPOSAL }),
  (p, _s, i) => p ? parallel(['gaming and failure modes', 'implementation and maintenance cost'].map((lens) => () => agent(
    `Adversarial lens: ${lens}. Try to break this proposal. Check claims against the code when files are named; an attack the code already prevents does not hold. Default to holds=true only when you can show the path.\nPROPOSAL: ${p.title}\n${p.design}\n${ctx}`,
    { label: `attack:${i + 1}:${lens.split(' ')[0]}`, phase: 'Attack', schema: CRITIQUE }))).then((cs) => ({ p, critiques: cs.filter(Boolean) })) : null,
)
const panel = results.filter(Boolean)
log(`${panel.length}/${stances.length} proposals attacked`)

phase('Synthesize')
const dossier = panel.map(({ p, critiques }) => `## ${p.title} (${p.stance}; tier ${p.proportionality_tier})\n${p.design}\nGives up: ${p.gives_up}\n` +
  critiques.map((c) => `### ${c.lens} → ${c.verdict}\n` + c.attacks.filter((a) => a.holds).map((a) => `- [${a.severity}] ${a.claim}: ${a.evidence}`).join('\n')).join('\n')).join('\n\n---\n\n')
const synth = await agent(`You are the synthesis seat. Weigh attacks by whether they HOLD, not by count; re-open the code for any attack you rely on. Produce ONE recommended design grafting the best surviving ideas. List every genuine conflict where reasonable engineers disagree and the choice changes the design, with both positions, your lean, and why the user must decide. List what was rejected and why, and what you could not verify.\n${ctx}\n\nDOSSIER\n${dossier}`, { label: 'synthesize', phase: 'Synthesize', schema: SYNTH, effort: 'max' })
return { panel: panel.map(({ p, critiques }) => ({ title: p.title, stance: p.stance, verdicts: critiques.map((c) => c.verdict) })), ...synth }
