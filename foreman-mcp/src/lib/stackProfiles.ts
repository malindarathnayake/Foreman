import fs from "fs/promises"
import path from "path"

/**
 * Stack profile resolution for Foreman.
 *
 * Foreman's engineering-ethos content has stack-specific paragraphs (telemetry
 * backends, security-framework flavor) factored out of the generic protocol text
 * into a "stack profile". Consumers select an active profile either via the
 * FOREMAN_STACK_PROFILE environment variable (picking a bundled profile) or by
 * overriding individual sections with a project file at
 * `<docsDir>/foreman-stack-profile.md`. Unknown ids fail open to the bundled
 * "reference" profile — same fail-open posture as resolveHost in hostProfiles.ts.
 */

export interface StackProfile {
  id: string
  displayName: string
  /** Map of section id -> markdown body. Referenced from docs/skills via {{stack: <section-id>}} markers. */
  sections: Record<string, string>
}

export const KNOWN_STACK_PROFILES: ReadonlyArray<string> = ["reference"]

const REFERENCE_TELEMETRY_BACKENDS = `OTEL is the required telemetry data model, correlation, and export path: traces and metrics via OTEL APIs; logs via your logging library bridged into the OTEL pipeline (direct Logs API only when justified).

- **Metrics** → InfluxDB via the collector's \`influxdb\` exporter. On the OTLP→Influx path every metric attribute becomes a tag and there is no per-metric field escape hatch — unbounded values (user IDs, request IDs, hashes, timestamps, error strings) are never metric attributes; carry them on span attributes or log fields and correlate via \`trace_id\`. Series cardinality is driven by tag values; unbounded tags kill Influx and exhaust SDK metric-stream memory first.
- **Logs** → Graylog via OTLP/gRPC into its OpenTelemetry input (gRPC only, logs signal only — the collector has **no GELF exporter**). "GELF" names the structured-log **field schema**, not a collector wire format; a direct GELF appender → Graylog GELF input is the documented exception when the collector is not in the log path, and the Telemetry Contract must declare which transport is in use.
- **GELF field-schema rules**: stable snake_case field names as stored/queried in Graylog (the GELF appender adds the wire-mandated \`_\` prefix to custom fields). Never name a custom field \`id\` (GELF forbids \`_id\`) or a reserved core name (\`version\`, \`host\`, \`short_message\`, \`full_message\`, \`timestamp\`, \`level\`); levels map to syslog severities 0–7; \`trace_id\`/\`span_id\` (hex, matching the active span context) on every structured log. On the OTLP path these are log-record attributes and the underscore rule does not apply — the contract states which transport it targets.`

const REFERENCE_SECURITY_FRAMEWORKS = `Threat modeling uses MITRE ATT&CK: map each threat-table row to the technique ID(s) an attacker would use at that boundary (e.g. T1190, T1552). For AI/LLM components use MITRE ATLAS IDs (AML.T####). Map threats to technique IDs, NOT the data-source taxonomy; where an ATT&CK detection strategy exists for the technique, cite it — never invent mappings.`

const REFERENCE_PROFILE: StackProfile = {
  id: "reference",
  displayName: "Reference stack (OTEL → InfluxDB/Graylog · MITRE ATT&CK/ATLAS)",
  sections: {
    "telemetry-backends": REFERENCE_TELEMETRY_BACKENDS,
    "security-frameworks": REFERENCE_SECURITY_FRAMEWORKS,
  },
}

/**
 * Returns the bundled stack profile for a known id. Currently only "reference"
 * is bundled; additional stack profiles can be added here as new consumers need
 * different telemetry/security defaults.
 */
export function getStackProfile(id: "reference"): StackProfile {
  switch (id) {
    case "reference":
      return REFERENCE_PROFILE
  }
}

/**
 * Parses section-tagged markdown of the form:
 *   <!-- section: id -->
 *   BODY
 *   <!-- /section -->
 * and returns a map of section id -> body. Section body is the content strictly
 * between the opening and closing markers, with outer newlines trimmed. Used by
 * both _common-protocol.md (skillLoader's {{include:}} markers) and
 * foreman-stack-profile.md (this module's {{stack:}} markers).
 */
export function parseSectionTags(source: string): Map<string, string> {
  const map = new Map<string, string>()
  const openTag = "<!-- section:"
  const closeTag = "<!-- /section -->"
  let pos = 0

  while (true) {
    const openIdx = source.indexOf(openTag, pos)
    if (openIdx === -1) break

    // Find end of opening tag line
    const openTagEnd = source.indexOf("-->", openIdx)
    if (openTagEnd === -1) break
    const markerEnd = openTagEnd + 3 // past "-->"

    // Extract the section id from "<!-- section: <id> -->"
    const idRaw = source.slice(openIdx + openTag.length, openTagEnd)
    const id = idRaw.trim()

    // Find the closing tag
    const closeIdx = source.indexOf(closeTag, markerEnd)
    if (closeIdx === -1) break

    // Body is content between end of opening marker and start of closing marker
    const body = source.slice(markerEnd, closeIdx).replace(/^\n/, "").replace(/\n$/, "")
    map.set(id, body)

    pos = closeIdx + closeTag.length
  }

  return map
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * Resolve the active stack profile from caller-provided env value and docs dir.
 *
 * Precedence:
 *   1. opts.env non-empty and a known bundled profile id → that bundled profile.
 *   2. opts.env non-empty but unknown → stderr warning, fall back to "reference"
 *      WITHOUT consulting the override file (mirrors resolveHost falling
 *      straight to the default rather than trying another source).
 *   3. opts.env empty/absent → look for an override file at
 *      `<opts.docsDir ?? "Docs">/foreman-stack-profile.md`. If present and it
 *      parses to at least one section, return an "override" profile built from
 *      those sections.
 *   4. Override file present but zero sections parse → stderr warning
 *      (malformed override), fall back to "reference".
 *   5. Override file absent or unreadable → "reference" silently (absence is
 *      the normal case, not a warning-worthy condition).
 *
 * Fail-open throughout: an unresolvable or malformed configuration should never
 * block skill loading, only fall back to the bundled reference profile.
 */
export async function resolveStackProfile(opts: {
  env?: string | null
  docsDir?: string
}): Promise<StackProfile> {
  const env = opts.env?.trim()

  if (env) {
    if ((KNOWN_STACK_PROFILES as ReadonlyArray<string>).includes(env)) {
      return getStackProfile(env as "reference")
    }

    console.error(
      `[foreman] Unknown FOREMAN_STACK_PROFILE value "${env}" — falling back to "reference". ` +
        `Accepted values: ${KNOWN_STACK_PROFILES.join(", ")}.`
    )
    return REFERENCE_PROFILE
  }

  const overridePath = path.join(opts.docsDir ?? "Docs", "foreman-stack-profile.md")

  if (!(await fileExists(overridePath))) {
    return REFERENCE_PROFILE
  }

  let sectionMap: Map<string, string>
  try {
    const source = await fs.readFile(overridePath, "utf-8")
    sectionMap = parseSectionTags(source)
  } catch {
    return REFERENCE_PROFILE
  }

  if (sectionMap.size === 0) {
    console.error(
      `[foreman] Stack profile override at "${overridePath}" contains no parseable sections — ` +
        `falling back to "reference".`
    )
    return REFERENCE_PROFILE
  }

  return {
    id: "override",
    displayName: "Project override (foreman-stack-profile.md)",
    sections: Object.fromEntries(sectionMap),
  }
}
