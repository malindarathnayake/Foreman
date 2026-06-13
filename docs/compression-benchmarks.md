# Reversible Output Compression — Benchmarks

Foreman ships a reversible, content-aware compression pilot (CCR) for large
`run_tests` and `invoke_advisor` output. Compressed results carry a
`<<ccr:HASH>>` marker; the full original is recoverable byte-for-byte through
the `retrieve_original` tool. On by default; kill switch `FOREMAN_COMPRESSION=0`;
per-tool scope `FOREMAN_COMPRESSION_TOOLS` (default `run_tests,invoke_advisor`).

This document quantifies the savings. It reports **sizes and ratios only** — no
log content, hostnames, paths, payloads, or identifiers from any source data.

**Measured on:** `@malindarathnayake/foreman-mcp@0.2.2`, bundled
`context-crush@0.1.0`, Node.js `>=22`.

---

## Method

Inputs were run through the exact installed pipeline the live MCP server uses:

```text
foreman maybeCompress(tool, text)  →  context-crush compress()  →  CCR store
```

For each sample we record the compressor's own `originalBytes` /
`compressedBytes`, the chosen strategy, and a round-trip check
(`store.get(hash) === original`). Byte counts are exact. **Token figures are
estimates** (`chars / 4`); the percentage reduction is the stable, content-driven
result and holds regardless of tokenizer.

Compression is content-aware. Output below the minimum size, or that the
detector classifies as prose/text, or that fails the benefit-ratio check, is
passed through unchanged (0% — no compression, no overhead).

---

## Real-world results

Representative production tool outputs (a verbose HTTP request log, a browser
console error log, and a network-configuration JSON file). Only aggregate sizes
and ratios are shown.

| Sample | Strategy | Original | Compressed | Saved | Round-trip |
|---|---|---:|---:|---:|---|
| HTTP request log | log | 50,000 B | 4,108 B | **91.8%** | LOSSLESS |
| Browser console error log | log | 15,139 B | 4,547 B | **70.0%** | LOSSLESS |
| Network-config JSON | log | 49,460 B | 3,500 B | **92.9%** | LOSSLESS |
| Clean passing test run (small) | passthrough | 1,723 B | — | 0% (below threshold) | n/a |

**Aggregate over the compressible payloads:** 114,599 B → 12,155 B =
**~89% reduction** (≈ 28,650 → 3,039 estimated tokens, ≈ 25,600 tokens kept out
of context), all lossless.

---

## Live, reproducible demonstration

A self-contained run through the **running MCP server**, using a synthetic
log generator with only `example.*` domains — no real data.

### 1. Generator

`package.json`

```json
{ "name": "ccrdemo", "version": "1.0.0", "private": true, "scripts": { "test": "node emit.js" } }
```

`emit.js`

```js
const hosts = ["app.example.com", "cdn.example.org", "assets.example.net"];
const paths = ["/api/v1/layers/list", "/api/v1/preferences", "/static/css/app.css", "/static/css/theme.css"];
let ts = 1700000000000;
for (let i = 0; i < 600; i++) {
  const host = hosts[i % hosts.length];
  const path = paths[i % paths.length];
  const code = i % 9 === 0 ? "[FAILED] net::ERR_FAILED" : "[200] ";
  console.log(`[GET] https://${host}${path}?_=${ts++} => ${code}`);
}
console.error("Total messages: 600 (Errors: 67, Warnings: 0)");
```

### 2. Run it through the live tool

```text
mcp__foreman__run_tests({ runner: "npm", args: ["test", "--prefix", "/path/to/ccrdemo"], max_output_chars: 50000 })
```

The server returns a digest: a sample of anchor lines, the collapsed bulk
(e.g. `[427 lines omitted: 54 FAIL]` — the failure count is preserved), and a
marker:

```text
[context-crush: original stored — retrieve_original <<ccr:e4d905f26e846da27f2fd447>>]
```

### 3. Recover the exact original

```text
mcp__foreman__retrieve_original({ hash: "e4d905f26e846da27f2fd447" })
```

Returns the full original — large enough that it round-trips byte-for-byte while
having lived *outside* the active context.

### Result

| | Chars | ~Tokens |
|---|---:|---:|
| Original (would sit in context) | 47,106 | ~11,777 |
| Compressed digest (what stays) | 5,411 | ~1,353 |
| **Saved** | **41,695 (88.5%)** | **~10,424** |
| Round-trip | **LOSSLESS** | |

Verified end to end: `detect → compress → marker → store → retrieve → exact original`.

### Measure it yourself

```js
// run with: node measure.mjs   (adjust the global install path as needed)
import { execSync } from "node:child_process";
const FM = execSync("npm root -g").toString().trim() + "/@malindarathnayake/foreman-mcp";
const { maybeCompress, getStore } = await import(FM + "/dist/lib/compression.js");

let text = execSync("node ./ccrdemo/emit.js", { encoding: "utf8", maxBuffer: 1e7 });
if (text.length > 50000) text = text.slice(0, 50000);

const out = maybeCompress("run_tests", text);
const hash = out.match(/<<ccr:([0-9a-f]{24})>>/)?.[1];
const lossless = hash && getStore().get(hash) === text;
console.log(`${text.length} -> ${out.length} chars (${(100*(1-out.length/text.length)).toFixed(1)}% saved), lossless: ${lossless}`);
```

---

## How to read this

- **Compressible bulk** — logs, error dumps, smoke runs, config JSON — reduces
  **70–93%**, losslessly. This is exactly the high-volume output that otherwise
  floods an agent's context window.
- **Lossless, not lossy-from-your-view.** The bulk is moved out of live context
  and stored; `retrieve_original` returns the exact bytes on demand. The agent
  pays the token cost only when it actually needs the detail.
- **Clean/small output passes through at 0%** — no compression, no overhead, no
  risk. A tidy green test run stays verbatim.
- **Savings compound across a session.** Every large `run_tests` / advisor result
  gets this treatment, so context relief is cumulative, not one-time.

## Caveats

- Byte percentages are exact (from the compressor's reported byte counts). Token
  figures are `chars / 4` estimates; URL-dense logs tokenize differently, but the
  ratio is stable.
- Large tool output is captured up to `max_output_chars` (≤ 50,000) before
  compression, mirroring the `run_tests` cap. Inputs larger than the cap save
  even more in absolute terms.
- Compression ratio is content-dependent. Highly repetitive logs compress best;
  already-terse or prose output compresses little or passes through by design.
- CCR entries are in-memory with a TTL (`CONTEXT_CRUSH_CCR_TTL_SECONDS`, default
  300s). `retrieve_original` returns an error once an entry expires.
