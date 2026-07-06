# SYNC.md

Fork-discipline record for the vendored `context-crush` package.

## Pinned upstream revisions

Source of truth: `vendor/context-crush/NOTICE`.

- `headroom/transforms/log_compressor.py @ 45720301`
- `headroom/transforms/diff_compressor.py @ f5f46541`
- `headroom/transforms/smart_crusher.py @ c765c53b`

## Divergence log

| # | Date | File | Change | Origin | Adaptations | Guard test |
|---|------------|------|--------|--------|--------------|------------|
| 1 | 2026-07-06 | `dist/compressors/logCompressor.js` | Must-keep token guard: force-selection pass + adaptive-cap exemption in `_selectLines` | Line-level adaptation of upstream `_KOMPRESS_MUST_KEEP_RE` from `headroom/transforms/kompress_compressor.py` (word-level, Kompress ML compressor — upstream's own line-based `log_compressor.py` has NO such guard at HEAD, so this is an adaptation, not a cherry-pick) | Bare hex ids >=8 chars (upstream: 0x-prefixed); left-guarded CLI-flag class; ALLCAPS requires a digit or underscore; upstream's "standalone number" and bare dotted-name classes are omitted from the force set (measured 83-99.9% line-match on real log fixtures — force-keeping them disables compression entirely) | `tests/compression.test.ts` must-keep suite |

## Review-on-sync procedure

On every sync with upstream:

1. Diff the three vendored compressor source files against their pinned upstream revisions.
2. Re-verify each divergence-log entry above still applies against the new upstream code; re-run the guard test for each entry.
3. Update the pins in this file (and in `NOTICE`) to the new upstream revisions.
4. Append a new row to the divergence log for any change carried forward or newly ported.
5. Never regenerate the vendored `dist/` output from anywhere other than this hand-applied, reviewed process.

## Byte-determinism invariant

Compressors MUST be deterministic for identical input; Foreman never rewrites already-emitted content; no LLM summarization inside `maybeCompress` — ever. This protects provider prompt caching.
