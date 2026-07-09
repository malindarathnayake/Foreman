# Dojo — local-vs-frontier bake-off arena (Foreman 0.5.5_experimental)

Three arms run the SAME two tasks from BYTE-IDENTICAL briefs and starting files:

| Arm | Model | Driver |
|---|---|---|
| `local`  | `reasoner-large` (Nemotron-3-Super-120B-A12B-NVFP4) @256K | `mcp__foreman__aider_worker` (whole_file, one-shot) |
| `sonnet` | Sonnet 5 | Agent worker, one-shot, no iteration |
| `opus`   | Opus 4.8 | Agent worker, one-shot, no iteration |

## Tasks

- **T1 — coding** (`T1-semver/`): implement a SemVer 2.0.0 module from `spec.md`.
  Objective score = fraction of `acceptance.test.mjs` assertions passing.
- **T2 — review** (`T2-review/`): find the planted bugs in `target.mjs` per `review-brief.md`.
  Score = recall/precision vs the hidden `answer-key.md`.

## Fairness invariants

1. Identical brief text + identical starting file bytes across arms.
2. One shot per arm. No worker runs the tests. No repo exploration.
3. `acceptance.test.mjs` and `answer-key.md` are GROUND TRUTH — never shown to a worker.
4. The orchestrator (pit-boss) scores objectively, then an ultracode workflow grades qualitatively.

Per-arm outputs live in `T1-semver/<arm>/semver.mjs` and `T2-review/<arm>/REVIEW.md`.
