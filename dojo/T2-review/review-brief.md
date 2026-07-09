# T2 — Code review

Review the JavaScript module `sessionCache.mjs` — an in-memory session cache with
TTL plus two HTTP helpers, intended for a production API gateway.

Find every DEFECT: correctness bugs, concurrency/async bugs, security
vulnerabilities, and resource leaks. For each finding, report:

- **location** — function + the specific line or code fragment,
- **what is wrong** and the concrete failure it causes,
- **severity** — critical / high / medium / low,
- a **CWE id** for security findings.

Rank findings most-severe first. Do NOT rewrite the module. If a piece of code is
correct, do not invent a problem with it. Output your review as Markdown, one
section per finding.
