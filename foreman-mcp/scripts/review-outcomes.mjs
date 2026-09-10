#!/usr/bin/env node
/**
 * Cross-ledger review outcomes (0.6.19 slice 7).
 *
 *   node scripts/review-outcomes.mjs <ledger.json> [<ledger.json> ...]
 *
 * Sums gate_totals, escapes and independence overrides across N Foreman ledgers and
 * renders the same review_outcomes table read_ledger renders for one, followed by the
 * owner-review triggers evaluated ledger-wide. The per-project table is a floor; this is
 * where a review path earns or loses its standing after enough projects. Requires a
 * build (dist/): the rendering is the library's own, never a second implementation.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const lib = path.resolve(__dirname, "..", "dist", "lib", "reviewBasis.js")
let renderReviewOutcomes
try {
  ;({ renderReviewOutcomes } = await import(`file://${lib.replace(/\\/g, "/")}`))
} catch {
  console.error(`[review-outcomes] cannot load ${lib}; run \`npm run build\` first`)
  process.exit(2)
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("[review-outcomes] usage: node scripts/review-outcomes.mjs <ledger.json> [...]")
  process.exit(2)
}

// Merge: every phase keyed by "<file>:<phase>" so nothing collides; the independence
// streak is per ledger and is reported per ledger below, not summed.
const merged = { v: 0, ts: "", phases: {} }
const streaks = []
for (const file of files) {
  let ledger
  try {
    ledger = JSON.parse(await readFile(file, "utf-8"))
  } catch (err) {
    console.error(`[review-outcomes] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`)
    continue
  }
  const tag = path.basename(path.dirname(path.resolve(file))) || file
  for (const [id, phase] of Object.entries(ledger.phases ?? {})) merged.phases[`${tag}:${id}`] = phase
  if (ledger.independence) streaks.push(`${tag}: ${ledger.independence.streak}${ledger.independence.phases?.length ? ` (${ledger.independence.phases.join(", ")})` : ""}`)
}

console.log(`ledgers: ${files.length}`)
console.log(renderReviewOutcomes(merged))
if (streaks.length > 0) console.log(`independence streaks per ledger: ${streaks.join("; ")}`)
