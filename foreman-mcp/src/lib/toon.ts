/**
 * Converts a record into key: value lines
 * Example output:
 * bundle_version: 0.0.1
 * compatible: true
 * update_available: false
 */
export function toKeyValue(record: Record<string, string | number | boolean>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(record)) {
    lines.push(`${key}: ${String(value)}`)
  }
  return lines.join("\n")
}

/**
 * Converts headers + rows into a pipe-delimited table
 * Example output:
 * version | date | description
 * 0.0.1 | 2026-04-02 | Initial release
 */
export function toTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ""
  const lines: string[] = []
  lines.push(headers.join(" | "))
  for (const row of rows) {
    lines.push(row.join(" | "))
  }
  return lines.join("\n")
}
