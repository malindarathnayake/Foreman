#!/usr/bin/env npx tsx
/**
 * Foreman MCP Benchmark Suite
 *
 * Measures performance of key operations before and after changes.
 * Run: npx tsx bench/bench.ts
 * Output: bench/results/<timestamp>.json + bench/results/latest.json
 *
 * Compares against previous run if bench/results/latest.json exists.
 */

import fs from "fs/promises"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(__dirname, "results")

// ── Benchmark Utilities ──────────────────────────────────────────────────────

interface BenchResult {
  name: string
  ops: number
  avg_ms: number
  min_ms: number
  max_ms: number
  p95_ms: number
}

interface BenchReport {
  timestamp: string
  version: string
  node: string
  platform: string
  test_count: number
  test_duration_s: number
  benchmarks: BenchResult[]
}

async function bench(name: string, fn: () => Promise<void>, iterations = 50): Promise<BenchResult> {
  // Warmup
  for (let i = 0; i < 3; i++) await fn()

  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await fn()
    times.push(performance.now() - start)
  }

  times.sort((a, b) => a - b)
  const avg = times.reduce((s, t) => s + t, 0) / times.length
  const p95 = times[Math.floor(times.length * 0.95)]

  return {
    name,
    ops: iterations,
    avg_ms: Math.round(avg * 100) / 100,
    min_ms: Math.round(times[0] * 100) / 100,
    max_ms: Math.round(times[times.length - 1] * 100) / 100,
    p95_ms: Math.round(p95 * 100) / 100,
  }
}

// ── Import SUT ───────────────────────────────────────────────────────────────

const { readLedger, writeLedger } = await import("../src/lib/ledger.js")
const { readProgress, writeProgress } = await import("../src/lib/progress.js")
const { normalizeReview } = await import("../src/tools/normalizeReview.js")
const { toKeyValue, toTable } = await import("../src/lib/toon.js")
const { handleReadLedger } = await import("../src/tools/readLedger.js")
const { handleReadProgress } = await import("../src/tools/readProgress.js")

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-bench-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function bigString(n: number): string {
  return "x".repeat(n)
}

function reviewText(findings: number): string {
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
  return Array.from({ length: findings }, (_, i) =>
    `${severities[i % 4]}: src/file${i}.ts:${i * 10} — Finding number ${i + 1} description here with some detail`
  ).join("\n")
}

// ── Benchmarks ───────────────────────────────────────────────────────────────

async function run(): Promise<BenchReport> {
  const pkg = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf-8"))
  const results: BenchResult[] = []

  console.log(`\nForeman MCP Benchmark — v${pkg.version}`)
  console.log("=".repeat(50))

  // 1. Ledger write (single unit status)
  results.push(await withTmpDir(async (dir) => {
    const p = path.join(dir, "ledger.json")
    return bench("ledger_write_unit_status", async () => {
      await writeLedger(p, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "ip" },
      })
    })
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 2. Ledger write (add rejection)
  results.push(await withTmpDir(async (dir) => {
    const p = path.join(dir, "ledger.json")
    await writeLedger(p, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip" } })
    return bench("ledger_write_add_rejection", async () => {
      await writeLedger(p, {
        operation: "add_rejection",
        phase: "p1",
        unit_id: "u1",
        data: { r: "reviewer", msg: bigString(500), ts: new Date().toISOString() },
      })
    })
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 3. Ledger read (full, small)
  results.push(await withTmpDir(async (dir) => {
    const p = path.join(dir, "ledger.json")
    await writeLedger(p, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "done" } })
    return bench("ledger_read_full_small", async () => {
      await handleReadLedger(p, { query: "full" })
    })
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 4. Ledger read (full, large — 10 phases × 10 units)
  results.push(await withTmpDir(async (dir) => {
    const p = path.join(dir, "ledger.json")
    for (let ph = 0; ph < 10; ph++) {
      for (let u = 0; u < 10; u++) {
        await writeLedger(p, {
          operation: "set_unit_status",
          phase: `phase-${ph}`,
          unit_id: `unit-${u}`,
          data: { s: "done" },
        })
      }
    }
    return bench("ledger_read_full_large_100units", async () => {
      await handleReadLedger(p, { query: "full" })
    })
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 5. Progress write + read cycle
  results.push(await withTmpDir(async (dir) => {
    const p = path.join(dir, "progress.json")
    await writeProgress(p, { operation: "start_phase", data: { phase: "p1", name: "Phase 1" } })
    return bench("progress_write_read_cycle", async () => {
      await writeProgress(p, {
        operation: "update_status",
        data: { unit_id: "u1", phase: "p1", status: "ip", notes: "working on it" },
      })
      await handleReadProgress(p)
    })
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 6. normalizeReview (small — 5 findings)
  results.push(await bench("normalize_review_5_findings", async () => {
    normalizeReview("reviewer", reviewText(5))
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 7. normalizeReview (large — 100 findings)
  results.push(await bench("normalize_review_100_findings", async () => {
    normalizeReview("reviewer", reviewText(100))
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 8. normalizeReview (stress — 10KB input)
  const bigReview = reviewText(5) + "\n" + bigString(10000)
  results.push(await bench("normalize_review_10kb_input", async () => {
    normalizeReview("reviewer", bigReview)
  }))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 9. TOON formatting (toKeyValue)
  const record = { key1: "value1", key2: "value2", key3: "value3", key4: true, key5: 42 }
  results.push(await bench("toon_key_value", async () => {
    toKeyValue(record)
  }, 500))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // 10. TOON formatting (toTable, 50 rows)
  const headers = ["phase", "unit", "status", "verdict", "notes"]
  const rows = Array.from({ length: 50 }, (_, i) => [`p${i}`, `u${i}`, "done", "pass", "ok"])
  results.push(await bench("toon_table_50_rows", async () => {
    toTable(headers, rows)
  }, 500))
  console.log(`  ${results[results.length - 1].name}: ${results[results.length - 1].avg_ms}ms avg`)

  // Get test count + duration
  console.log(`\nRunning test suite for metrics...`)
  const { execSync } = await import("child_process")
  const testStart = performance.now()
  let testOutput: string
  try {
    testOutput = execSync("npx vitest run", { cwd: path.join(__dirname, ".."), encoding: "utf-8", timeout: 120000 })
  } catch (e: any) {
    testOutput = e.stdout ?? ""
  }
  const testDuration = (performance.now() - testStart) / 1000

  const testCountMatch = testOutput.match(/(\d+) passed/)
  const testCount = testCountMatch ? parseInt(testCountMatch[1]) : 0

  const report: BenchReport = {
    timestamp: new Date().toISOString(),
    version: pkg.version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    test_count: testCount,
    test_duration_s: Math.round(testDuration * 10) / 10,
    benchmarks: results,
  }

  return report
}

// ── Compare ──────────────────────────────────────────────────────────────────

function compare(prev: BenchReport, curr: BenchReport): string {
  let output = `\nComparison: v${prev.version} → v${curr.version}\n`
  output += "=".repeat(50) + "\n"

  output += `Tests: ${prev.test_count} → ${curr.test_count} (${curr.test_count - prev.test_count >= 0 ? "+" : ""}${curr.test_count - prev.test_count})\n`
  output += `Suite duration: ${prev.test_duration_s}s → ${curr.test_duration_s}s\n\n`

  output += `${"Benchmark".padEnd(38)} ${"Before".padStart(8)} ${"After".padStart(8)} ${"Delta".padStart(8)} ${"Status".padStart(8)}\n`
  output += "-".repeat(72) + "\n"

  for (const curr_b of curr.benchmarks) {
    const prev_b = prev.benchmarks.find(b => b.name === curr_b.name)
    if (prev_b) {
      const delta = curr_b.avg_ms - prev_b.avg_ms
      const pct = ((delta / prev_b.avg_ms) * 100).toFixed(1)
      const status = Math.abs(delta) < 0.1 ? "=" : delta > 0 ? (delta > prev_b.avg_ms * 0.2 ? "REGRESS" : "~") : "FASTER"
      output += `${curr_b.name.padEnd(38)} ${(prev_b.avg_ms + "ms").padStart(8)} ${(curr_b.avg_ms + "ms").padStart(8)} ${(pct + "%").padStart(8)} ${status.padStart(8)}\n`
    } else {
      output += `${curr_b.name.padEnd(38)} ${"NEW".padStart(8)} ${(curr_b.avg_ms + "ms").padStart(8)} ${"".padStart(8)} ${"NEW".padStart(8)}\n`
    }
  }

  return output
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  const report = await run()

  // Save timestamped
  const tsFile = path.join(RESULTS_DIR, `${report.timestamp.replace(/[:.]/g, "-")}.json`)
  await fs.writeFile(tsFile, JSON.stringify(report, null, 2))

  // Compare with previous if exists
  const latestPath = path.join(RESULTS_DIR, "latest.json")
  try {
    const prev = JSON.parse(await fs.readFile(latestPath, "utf-8")) as BenchReport
    console.log(compare(prev, report))
  } catch {
    console.log("\nNo previous benchmark to compare against.")
  }

  // Save as latest
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2))

  console.log(`\nResults saved to: ${tsFile}`)
  console.log(`Latest: ${latestPath}`)
}

main().catch(console.error)
