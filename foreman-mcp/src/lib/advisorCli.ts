export const ADVISOR_CLIS = ["claude", "codex", "gemini"] as const

export type AdvisorCli = (typeof ADVISOR_CLIS)[number]
