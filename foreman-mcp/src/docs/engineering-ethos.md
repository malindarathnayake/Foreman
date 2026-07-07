<!-- canonical engineering ethos — bundled with foreman-mcp; served by the `ethos` tool with the active stack profile rendered into the stack-section markers -->
<!-- v1.1 · 2026-07-06 · pillars: mechanical sympathy / security / contract-first observability · stack-specific content (telemetry backends, threat framework) lives in the stack profile -->

# Engineering Ethos — Mechanical Sympathy · Security · Observability

Three pillars, one rule: **abstractions, controls, and telemetry are costs to justify — and every justification gets recorded, not just made.** Applies to all design, spec, implementation, and review work. Force is proportional to declared tier.

## Proportionality — declare a tier, don't assume one

| Tier | Applies to | What it demands |
|---|---|---|
| `standard` | Default — CRUD, tooling, glue, batch | Pillar *awareness* list only. No perf gates. |
| `hot` | Latency-sensitive paths (SLO in the tens of ms or tighter), handlers above the spec-declared QPS threshold (absent a declaration, ~1k req/s per instance), CPU-heavy or sync-I/O work on a shared event loop serving latency-SLO'd traffic | Perf budget stated in spec; every change on the path carries a **stated perf rationale**; the implementor's Ethos Compliance gate (G6) applies. |
| `extreme` | µs-class paths (trading-style, packet processing, tight kernels) | Everything in `hot`, plus: measured before/after on every change, allocation-free steady state as default posture, syscall/lock audit per change, scheduler/affinity posture stated (CPU pinning, NUMA locality of hot data). |

Tier is declared **per phase or unit** in the design summary and spec. Undeclared = `standard` **for reviewers judging existing code only** — document generators (design summary, spec) must obtain an explicit tier per major path; an undeclared tier there is a gap to escalate, not a default to apply. Claiming `standard` for a path with an SLO of ~10 ms or tighter is a review reject.

## Pillar 1 — Mechanical Sympathy

Core rules (non-negotiable at `hot`/`extreme`; awareness at `standard`):

1. Understand the execution model **before** optimizing: allocation/GC cost, syscall cost, cache locality, scheduler behavior.
2. Treat abstraction layers — virtual dispatch, dynamic containers, locks, serialization — as costs to justify, not defaults.
3. Prefer explicit, **benchmarked** designs over "idiomatic" choices on latency-critical paths. p99/p999, never means.
4. Ask of every hot-path operation: does this cross a kernel/syscall boundary unnecessarily? Can it be avoided or batched?
5. Hot-path code lacking a stated performance rationale is **flagged for review reject** — the rationale lives in the spec directive or a code comment citing it.

| Cost to justify | Question to answer in the rationale |
|---|---|
| Allocation in a loop / per-request | Can it be pooled, reused, or stack-allocated? What's the GC/fragmentation pressure? |
| Lock / shared mutable state | Contention profile? Can state be sharded per-core/goroutine/worker instead (padded to cache-line boundaries — unpadded shards reintroduce the cost as false sharing)? |
| Data layout / shared cache lines | Hot fields contiguous per access pattern (no per-element pointer chasing)? Sharded counters padded/aligned to cache lines? |
| Syscall / kernel crossing | Batchable (writev, sendmmsg, buffered)? Amortized? |
| Serialization on the path | Needed here, or at the boundary? Zero-copy option? |
| Virtual dispatch / reflection / dynamic lookup | Monomorphic alternative? Is it actually on the path? |
| Cross-service hop | Can it be batched, cached, or moved off the critical path? |

`standard`-tier awareness list (always applies, no gate): no N+1 queries, no sync I/O on event loops, no unbounded queues or caches, batch external calls where natural, know your framework's per-request allocation story.

Measurement rules: budgets live in the spec (per phase/unit). `extreme` changes cite benchmark/profile evidence on **every** change; `hot` changes cite evidence when the change plausibly moves the budgeted metric (new allocation, lock, syscall, or added work on the path) and a stated rationale otherwise. A measured regression against budget is a failing gate at either tier, not a note. Latency evidence must be coordinated-omission-safe (open-loop/arrival-rate load, HdrHistogram-style capture); report p50/p99/p999 (+ max at `extreme`), same hardware and frequency-governor settings, warmup excluded; `extreme` comparisons pin CPUs.

## Pillar 2 — Security (framework-evaluated)

**Design time — threat table required** for any component crossing a trust boundary:

| Column | Content |
|---|---|
| Component | The thing that can be compromised |
| Compromise impact | What the attacker gains |
| Technique(s) | Technique ID(s) — from the active stack profile's threat framework — an attacker would use to compromise this component at this boundary; the techniques the Controls column mitigates and Detection evidence observes. Post-compromise follow-ons belong in Compromise impact. Techniques, NOT a data-source taxonomy |
| Controls | The specific mitigations, each a cost justified by this row |
| Detection evidence | The **named telemetry event/field** that would evidence exploitation — concrete, from the Telemetry Contract |

{{stack: security-frameworks}}

**Review time:** every security finding carries a `[CWE-###]` prefix in its description (e.g. `[CWE-89] raw string concat into query — file.ts:42`). If no specific CWE fits, use the closest class CWE (e.g. CWE-693 Protection Mechanism Failure) or `[CWE-UNMAPPED]` with a one-line reason — a wrong CWE is worse than an explicit unmapped tag. Findings persist via Foreman `record_review`. Severity follows the standard scale — real bugs, not style. Reviewers reference existing Threat Table rows; they do not mint new technique mappings during code review.

**Hard rules (all tiers):**
- Secrets never appear in worker briefs, prompts, spans, metrics, or logs. A secret in telemetry or a brief is a CRITICAL finding.
- Audit events (authn/authz decisions, privilege changes, data access) are a **separate stream** from ops logs — append-only intent, stable schema.
- Supply chain: dependency scan at phase gates; a new critical advisory fails the gate.
- Security-vs-performance conflicts are **recorded and arbitrated** (spec Decisions row or ledger note) — never silently dropped in either direction.

## Pillar 3 — Observability (contract-first)

{{stack: telemetry-backends}}

**The contract is the field schema, not the wire format** — app code never knows the backend.

**Telemetry Contract** — declared in the spec, per component:

| Element | Must declare |
|---|---|
| Spans | Names (OTEL semantic conventions where they exist), key attributes, parent relationships |
| Metrics | Name, type, unit, **tag keys AND per-tag bounded value set or max expected cardinality**. Unbounded values (user IDs, request IDs, hashes, timestamps, error strings) are **never metric attributes** — carry them on span attributes or log fields and correlate via `trace_id`. Series cardinality is driven by tag *values*; backend-specific tag/field semantics come from the active stack profile |
| Logs (structured schema) | Stable snake_case field names as stored/queried in the log backend; `trace_id`/`span_id` (hex, matching the active span context) on every structured log; severity levels map to the backend's scheme. Reserved-name and transport rules come from the active stack profile |
| Audit events | Separate stream/facility, schema, retention intent |
| Sampling | Head/tail trace sampling policy stated; log volume expectations |

**Observability obeys Pillar 1:** batch exporters only; never a synchronous export/flush on a hot path; counters/histograms aggregate in-process and export on interval; instrumentation on `extreme` paths is itself budgeted.

**Telemetry is attack surface:** no secrets/PII in any signal; telemetry sinks are authenticated; unbounded cardinality/volume is a self-inflicted DoS — the bounds above are a security control too.

## Cross-pillar rules

1. **Conflicts are recorded, never silently resolved.** Perf-vs-security, perf-vs-telemetry, cost-vs-coverage — write the trade into the spec Decisions table or ledger note; the user arbitrates non-trivial ones.
2. **Every gate claim needs evidence** — `file:line`, benchmark output, config excerpt. Assertions without evidence don't pass gates.
3. **Proportionality is declared, not inferred.** The tier is in the spec; reviewers check the declaration, not vibes.

## Design-time question set (design sessions must cover)

1. What tier is each major path — `standard`, `hot`, `extreme` — and what's the latency/throughput budget for anything above standard?
2. What crosses a kernel/syscall or network boundary on the critical path, and what's batched?
3. What are the trust boundaries, and what does an attacker gain at each (→ threat table rows)?
4. Where do secrets live, and what prevents them from reaching briefs/telemetry?
5. What must be observable to *operate* this (SLO signals) and to *detect abuse* of it (detection evidence)?
6. What are the metric tag keys, and what bounds every tag's value set?
7. Which pillar conflicts exist already, and who arbitrates them?

## Review-time checklist (implementor Ethos Compliance gate G6 / council lenses)

| Check | Applies | Reject when |
|---|---|---|
| Perf rationale present & cited | `hot`/`extreme` units | Hot-path change with no stated rationale |
| No unjustified alloc/lock/syscall | `hot`/`extreme` units | Cost added without a justification row |
| Budget respected | `hot`/`extreme` units | Benchmark/profile shows regression vs spec budget |
| Telemetry matches contract | units touching telemetry | Names/tags/fields drift from spec; unbounded tag values |
| No secrets/PII in signals or briefs | always | Any occurrence — CRITICAL |
| Security findings CWE-tagged | review outputs | Untagged security finding (closest class CWE or `[CWE-UNMAPPED]` + reason is acceptable; a fabricated CWE is not) |
| Conflicts recorded | always | A pillar trade made silently |
