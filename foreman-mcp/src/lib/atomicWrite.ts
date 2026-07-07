import fs from "fs/promises"
import { randomBytes } from "crypto"

// Windows-only rename retry: unlike POSIX rename(2), Win32 MoveFileEx does not guarantee
// an atomic replace under contention — two processes renaming their own tmp file onto the
// same destination at nearly the same instant can make one rename transiently fail with
// EPERM (observed empirically; the same code libraries like write-file-atomic retry on).
// This is exactly the cross-process race this helper exists to survive, so a short retry
// is load-bearing here, not cosmetic. A *permanent* EPERM (e.g. destination is a directory)
// still fails — it just does so after exhausting the retries below.
const RENAME_RETRY_ATTEMPTS = 5
const RENAME_RETRY_DELAY_MS = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Atomic file write: write to a uniquely-suffixed tmp path, then rename over the target.
 * The random suffix guards CROSS-process collisions — a fixed `.tmp` sibling collides when
 * two server processes write the same file concurrently. In-process serialization remains
 * the job of each module's own per-path mutex (registries are deliberately NOT shared).
 * `opts.scrub` is a redaction seam consumed by 4b (D1) — no caller passes it yet.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  opts?: { scrub?: (s: string) => string }
): Promise<void> {
  const text = opts?.scrub ? opts.scrub(data) : data
  const tmpPath = `${filePath}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmpPath, text, "utf-8")
  } catch (err) {
    // A failed write (e.g. ENOSPC) can still leave a partial tmp behind —
    // same best-effort cleanup as the rename path, then rethrow.
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmpPath, filePath)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EBUSY")
      if (retryable && attempt < RENAME_RETRY_ATTEMPTS - 1) {
        await sleep(RENAME_RETRY_DELAY_MS * (attempt + 1))
        continue
      }
      break
    }
  }
  // Best-effort cleanup: don't leave the orphaned tmp behind, but the rename
  // failure is the caller's error — rethrow it.
  await fs.unlink(tmpPath).catch(() => {})
  throw lastErr
}
