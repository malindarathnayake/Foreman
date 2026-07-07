// Worker-response parser (Unit 4e). Parses the two-part response a remote patch-worker
// model returns — strict JSON metadata plus a sentinel-delimited patch — and classifies
// it into a closed set of outcomes. This module is a SECURITY CONTROL: a hostile
// endpoint's response text passes through here. It validates patch SHAPE only, never
// semantics (semantic validation and autocorrect are v0.6 and are explicitly out of
// scope here). No logging anywhere in this module.

import { containsRedactionMarker } from "./redaction.js"

export type EditFormat = "unified_diff" | "search_replace" | "whole_file"
export type FinishReasonClass = "stop" | "length" | "content_filter" | "other"
export type ResponseClassification =
  | "OK"
  | "MODEL_SCHEMA_FAIL"
  | "WORKER_GHOST"
  | "PATCH_PARSE_FAIL"
  | "PATCH_REDACTION_MARKER_FAIL"
  | "PATCH_PROTECTED_PATH_FAIL"

export interface WorkerMetadata {
  report: string
  files: string[]
  confidence?: number
  finish_note?: string
}

export interface ParsedWorkerResponse {
  classification: ResponseClassification
  metadata?: WorkerMetadata
  patch?: string
  targetPaths?: string[]
  detail?: string
}

export const PATCH_BEGIN = "-----BEGIN FOREMAN PATCH-----"
export const PATCH_END = "-----END FOREMAN PATCH-----"

const BOM = "﻿"

/**
 * Strips a leading UTF-8 BOM and converts all CRLF to LF. Pulled forward from D3
 * (a PowerShell BOM broke a JSON consumer mid-design). Called first by
 * parseWorkerResponse so every downstream scan operates on canonical text.
 */
export function canonicalize(raw: string): string {
  let text = raw
  if (text.startsWith(BOM)) {
    text = text.slice(BOM.length)
  }
  return text.replace(/\r\n/g, "\n")
}

/**
 * Scans for the first `{` and returns the text of the first balanced `{...}` block,
 * tracking JSON string/escape state so a `{` inside a string cannot confuse the brace
 * count. Returns undefined when no balanced block is found.
 */
function extractFirstJsonBlock(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return undefined
}

/** Shape-checks a parsed JSON value against the WorkerMetadata contract. Extra fields tolerated. */
function isWorkerMetadataShape(value: unknown): value is WorkerMetadata {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>

  if (typeof obj.report !== "string") return false
  if (!Array.isArray(obj.files) || !obj.files.every((f) => typeof f === "string")) return false
  if (obj.confidence !== undefined && typeof obj.confidence !== "number") return false
  if (obj.finish_note !== undefined && typeof obj.finish_note !== "string") return false

  return true
}

/**
 * Extracts the metadata object: finds the first balanced `{...}` block, parses it as
 * strict JSON, then shape-checks it. Returns undefined on any failure (absent,
 * unparsable, or shape-invalid) — the caller maps that to MODEL_SCHEMA_FAIL.
 */
function parseMetadata(text: string): WorkerMetadata | undefined {
  const block = extractFirstJsonBlock(text)
  if (block === undefined) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return undefined
  }

  if (!isWorkerMetadataShape(parsed)) return undefined

  return parsed
}

/**
 * Extracts the patch text strictly between an exact `PATCH_BEGIN` line and an exact
 * `PATCH_END` line (line-exact match after canonicalization, no leading/trailing
 * decoration on those lines). Returns undefined when the sentinel pair is not found.
 * The returned text is exactly what sits between the two sentinel lines — verbatim,
 * never trimmed.
 */
function extractPatch(text: string): string | undefined {
  const lines = text.split("\n")
  const beginIdx = lines.indexOf(PATCH_BEGIN)
  if (beginIdx === -1) return undefined

  const endIdx = lines.indexOf(PATCH_END, beginIdx + 1)
  if (endIdx === -1) return undefined

  return lines.slice(beginIdx + 1, endIdx).join("\n")
}

const UNIFIED_DIFF_FILE_HEADER = /^--- /m
const UNIFIED_DIFF_NEW_HEADER = /^\+\+\+ /m
const UNIFIED_DIFF_HUNK = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m

/** Extracts target paths from `+++ ` lines: strip a leading `b/`, trim at tab/EOL, ignore /dev/null. */
function unifiedDiffTargetPaths(patch: string): string[] {
  const paths: string[] = []
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue
    let rest = line.slice("+++ ".length)
    const tabIdx = rest.indexOf("\t")
    if (tabIdx !== -1) rest = rest.slice(0, tabIdx)
    if (rest.startsWith("b/")) rest = rest.slice(2)
    if (rest === "/dev/null") continue
    paths.push(rest)
  }
  return paths
}

function isWellFormedUnifiedDiff(patch: string): boolean {
  if (!UNIFIED_DIFF_FILE_HEADER.test(patch)) return false
  if (!UNIFIED_DIFF_NEW_HEADER.test(patch)) return false
  if (!UNIFIED_DIFF_HUNK.test(patch)) return false
  return true
}

const SEARCH_MARKER = "<<<<<<< SEARCH"
const DIVIDER_MARKER = "======="
const REPLACE_MARKER = ">>>>>>> REPLACE"

/**
 * Finds complete search_replace blocks: a non-empty path line, then an exact
 * `<<<<<<< SEARCH` line, then eventually an exact `=======` line, then eventually an
 * exact `>>>>>>> REPLACE` line, in that order. Returns the path line preceding each
 * complete block.
 */
function searchReplaceTargetPaths(patch: string): string[] {
  const lines = patch.split("\n")
  const paths: string[] = []

  let i = 0
  while (i < lines.length) {
    if (lines[i] !== SEARCH_MARKER) {
      i++
      continue
    }

    // Look backward for the nearest non-empty path line immediately preceding this marker.
    const pathLine = i > 0 ? lines[i - 1] : undefined
    const dividerIdx = lines.indexOf(DIVIDER_MARKER, i + 1)
    if (dividerIdx === -1) {
      i++
      continue
    }
    const replaceIdx = lines.indexOf(REPLACE_MARKER, dividerIdx + 1)
    if (replaceIdx === -1) {
      i++
      continue
    }

    if (pathLine !== undefined && pathLine.trim().length > 0) {
      paths.push(pathLine)
    }

    i = replaceIdx + 1
  }

  return paths
}

function isWellFormedSearchReplace(patch: string): boolean {
  return searchReplaceTargetPaths(patch).length > 0
}

const WHOLE_FILE_MARKER = /^===== FILE: (.+) =====$/

/**
 * Finds whole_file markers with at least one content line before the next marker or
 * patch end. Returns the trimmed path from each qualifying marker.
 */
function wholeFileTargetPaths(patch: string): string[] {
  const lines = patch.split("\n")
  const paths: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = WHOLE_FILE_MARKER.exec(lines[i])
    if (!match) continue
    const path = match[1].trim()
    if (path.length === 0) continue

    // Require at least one content line before the next marker or end of patch.
    let hasContent = false
    for (let j = i + 1; j < lines.length; j++) {
      if (WHOLE_FILE_MARKER.test(lines[j])) break
      if (lines[j].length > 0) {
        hasContent = true
        break
      }
    }

    if (hasContent) paths.push(path)
  }

  return paths
}

function isWellFormedWholeFile(patch: string): boolean {
  return wholeFileTargetPaths(patch).length > 0
}

/** SHAPE-only well-formedness check per edit format. Never validates that hunks apply or content makes sense. */
function isWellFormed(patch: string, editFormat: EditFormat): boolean {
  switch (editFormat) {
    case "unified_diff":
      return isWellFormedUnifiedDiff(patch)
    case "search_replace":
      return isWellFormedSearchReplace(patch)
    case "whole_file":
      return isWellFormedWholeFile(patch)
  }
}

/** Extracts target paths per edit format. Only called once well-formedness has already passed. */
function extractTargetPaths(patch: string, editFormat: EditFormat): string[] {
  switch (editFormat) {
    case "unified_diff":
      return unifiedDiffTargetPaths(patch)
    case "search_replace":
      return searchReplaceTargetPaths(patch)
    case "whole_file":
      return wholeFileTargetPaths(patch)
  }
}

/**
 * Normalizes a path for the protected-path check: converts backslashes to forward
 * slashes, collapses duplicate slashes, and resolves `.`/`..` segments lexically (no fs
 * access — this is a string operation, not a filesystem one).
 */
function normalizePathForCheck(rawPath: string): string {
  const slashed = rawPath.replace(/\\/g, "/")
  const isAbsolutePosix = slashed.startsWith("/")
  const isUnc = slashed.startsWith("//")
  const collapsed = slashed.replace(/\/{2,}/g, "/")

  const segments = collapsed.split("/")
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop()
      } else {
        resolved.push("..")
      }
      continue
    }
    resolved.push(segment)
  }

  let result = resolved.join("/")
  if (isUnc) {
    result = "//" + result
  } else if (isAbsolutePosix) {
    result = "/" + result
  }
  return result
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//
const FOREMAN_DOTFILE_BASENAME = /(^|\/)\.foreman[^/]*$/

/**
 * Determines whether an extracted target path is protected. docsDir is a relative dir
 * name (e.g. "Docs"); the comparison is case-insensitive since Windows paths are
 * case-insensitive.
 */
function isProtectedPath(rawPath: string, docsDir: string): boolean {
  const slashed = rawPath.replace(/\\/g, "/")

  // Absolute paths (POSIX, Windows drive, or UNC) are checked on the raw (pre-normalization)
  // form since normalization only collapses/resolves segments, not the leading marker.
  if (slashed.startsWith("/")) return true
  if (WINDOWS_DRIVE_ABSOLUTE.test(slashed)) return true

  const normalized = normalizePathForCheck(rawPath)

  if (normalized.startsWith("../")) return true
  if (normalized === "..") return true

  const lowerNormalized = normalized.toLowerCase()
  const lowerDocsDir = docsDir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase()
  if (lowerDocsDir.length > 0 && (lowerNormalized === lowerDocsDir || lowerNormalized.startsWith(lowerDocsDir + "/"))) {
    return true
  }

  if (FOREMAN_DOTFILE_BASENAME.test(normalized)) return true

  if (normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/")) {
    return true
  }

  return false
}

/**
 * Parses a worker's two-part response and classifies it into the closed
 * ResponseClassification set. Validates patch SHAPE only, never semantics. See module
 * header for the security posture this enforces.
 */
export function parseWorkerResponse(
  raw: string,
  opts: { editFormat: EditFormat; docsDir: string }
): ParsedWorkerResponse {
  const text = canonicalize(raw)

  const metadata = parseMetadata(text)
  if (metadata === undefined) {
    return { classification: "MODEL_SCHEMA_FAIL", detail: "metadata JSON absent, unparsable, or shape-invalid" }
  }

  // patchRaw is defined whenever the sentinel pair was found, even if the content
  // between them is empty/whitespace-only. `patch` is included on the result in that
  // case too — "present when sentinels found" per the module contract.
  const patchRaw = extractPatch(text)
  const patchFound = patchRaw !== undefined
  const patchIsEmpty = !patchFound || (patchRaw as string).trim().length === 0

  if (metadata.report === "success" && patchIsEmpty) {
    return {
      classification: "WORKER_GHOST",
      metadata,
      ...(patchFound ? { patch: patchRaw as string } : {}),
      detail: "metadata claims success but no patch was returned",
    }
  }

  if (patchIsEmpty) {
    return {
      classification: "OK",
      metadata,
      ...(patchFound ? { patch: patchRaw as string } : {}),
    }
  }

  // patch is guaranteed defined and non-empty past this point.
  const patchText = patchRaw as string

  if (!isWellFormed(patchText, opts.editFormat)) {
    return {
      classification: "PATCH_PARSE_FAIL",
      metadata,
      patch: patchText,
      detail: `patch is not well-formed for edit format "${opts.editFormat}"`,
    }
  }

  const targetPaths = extractTargetPaths(patchText, opts.editFormat)

  if (containsRedactionMarker(patchText)) {
    return {
      classification: "PATCH_REDACTION_MARKER_FAIL",
      metadata,
      patch: patchText,
      targetPaths,
      detail: "patch contains an inbound redaction marker",
    }
  }

  const protectedPath = targetPaths.find((p) => isProtectedPath(p, opts.docsDir))
  if (protectedPath !== undefined) {
    return {
      classification: "PATCH_PROTECTED_PATH_FAIL",
      metadata,
      patch: patchText,
      targetPaths,
      detail: `target path "${protectedPath}" is protected`,
    }
  }

  return { classification: "OK", metadata, patch: patchText, targetPaths }
}

const FINISH_REASON_KNOWN: readonly FinishReasonClass[] = ["stop", "length", "content_filter"]

/**
 * Normalizes a provider's raw finish-reason value to the closed FinishReasonClass enum.
 * The raw string is matched case-insensitively against the three known values; anything
 * else (other strings, undefined, null, non-strings) maps to "other". The raw value is
 * never returned or persisted — only the closed enum value leaves this function, so a
 * hostile endpoint cannot write free text into the sidecar via this path.
 */
export function normalizeFinishReason(raw: unknown): FinishReasonClass {
  if (typeof raw !== "string") return "other"
  const lowered = raw.toLowerCase()
  const match = FINISH_REASON_KNOWN.find((known) => known === lowered)
  return match ?? "other"
}
