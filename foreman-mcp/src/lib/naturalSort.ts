/**
 * Natural (numeric-aware) ordering for phase and unit ids.
 *
 * Plain lexicographic sort puts `p10` before `p2` and `U0.18` before `U0.9`, which
 * made `session_orient` resume the wrong phase on any project with ten or more
 * phases (field feedback 2026-09, Codex root cause R3). Numeric runs are compared
 * by value; ties fall back to a plain code-point compare so the order is total and
 * deterministic across locales.
 */
export function naturalCompare(a: string, b: string): number {
  const primary = a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
  if (primary !== 0) return primary
  return a < b ? -1 : a > b ? 1 : 0
}

/** Returns a new array sorted with {@link naturalCompare}. */
export function naturalSort(ids: Iterable<string>): string[] {
  return [...ids].sort(naturalCompare)
}
