export const EXTERNAL_ADVISOR_CLIS = ["claude", "codex", "gemini"] as const
export const ADVISOR_CLIS = ["claude", "codex", "gemini", "cursor"] as const

export type ExternalAdvisorCli = (typeof EXTERNAL_ADVISOR_CLIS)[number]
export type AdvisorCli = (typeof ADVISOR_CLIS)[number]

/** Cursor Agent CLI binaries. The editor UI CLI is `cursor` and is not an advisor. */
export const CURSOR_AGENT_BINS = ["agent", "cursor-agent"] as const

/**
 * MCP schema for capability_check / invoke_advisor. `cli: "cursor"` is Cursor-host
 * only so Claude Code and Codex keep the claude|codex|gemini surface.
 */
export function advisorClisForHost(host: string): typeof ADVISOR_CLIS | typeof EXTERNAL_ADVISOR_CLIS {
  return host === "cursor" ? ADVISOR_CLIS : EXTERNAL_ADVISOR_CLIS
}
