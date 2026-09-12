import fs from "fs/promises"
import path from "path"
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
 * Durability (0.6.26, field report 2026-09-11). A rename is atomic with respect to file
 * IDENTITY, not to the bytes behind it: the directory entry can reach the disk while the
 * data blocks the tmp file was given are still only in the page cache. If the machine
 * loses power or the process is killed in that window, the destination is left at the
 * right size filled with NUL — which is exactly what the field report observed, a 4.2 MB
 * ledger that was 100% zero bytes and cost every record written since the last commit.
 *
 * fsync before the rename closes that window: the data is durable before anything points
 * at it. fsync of the containing DIRECTORY after the rename makes the new directory entry
 * itself durable, so a crash cannot leave the old entry pointing at a freed inode. The
 * directory sync is POSIX-only and best-effort: Win32 has no handle for a directory's
 * metadata, and NTFS orders the rename's metadata itself, so its absence is not a gap
 * there. A failing fsync (a filesystem that does not implement it — some network mounts)
 * degrades to the previous behaviour rather than failing the write.
 */
async function syncDir(filePath: string): Promise<void> {
  if (process.platform === "win32") return
  let dir
  try {
    dir = await fs.open(path.dirname(filePath), "r")
    await dir.sync()
  } catch {
    /* best effort: a filesystem without directory fsync is not a write failure */
  } finally {
    await dir?.close().catch(() => {})
  }
}

/**
 * Durable append for the hash-chained sidecars (0.6.26). Same reasoning as the atomic
 * write above, one step smaller: the appended line is flushed before the call returns, so
 * a crash leaves the file either without the line or with all of it — never with a
 * zero-filled tail the chain readers would have to reject. The readers already refuse a
 * torn final line; this makes the torn line rare rather than merely survivable.
 */
export async function appendFileDurable(filePath: string, data: string): Promise<void> {
  const handle = await fs.open(filePath, "a")
  try {
    await handle.writeFile(data, "utf-8")
    await handle.sync().catch(() => {})
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Atomic file write: write to a uniquely-suffixed tmp path, flush it to disk, then rename
 * over the target. The random suffix guards CROSS-process collisions — a fixed `.tmp`
 * sibling collides when two server processes write the same file concurrently. In-process
 * serialization remains the job of each module's own per-path mutex (registries are
 * deliberately NOT shared). `opts.scrub` is a redaction seam consumed by 4b (D1) — no
 * caller passes it yet.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  opts?: { scrub?: (s: string) => string }
): Promise<void> {
  const text = opts?.scrub ? opts.scrub(data) : data
  const tmpPath = `${filePath}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`
  let handle
  try {
    handle = await fs.open(tmpPath, "w")
    await handle.writeFile(text, "utf-8")
    // The flush must happen while the handle is open and BEFORE the rename: this is the
    // single line that separates "the ledger is behind" from "the ledger is NUL".
    await handle.sync().catch(() => {})
  } catch (err) {
    // A failed write (e.g. ENOSPC) can still leave a partial tmp behind —
    // same best-effort cleanup as the rename path, then rethrow.
    await handle?.close().catch(() => {})
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }
  await handle.close()

  let lastErr: unknown
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmpPath, filePath)
      await syncDir(filePath)
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
