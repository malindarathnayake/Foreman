/**
 * preview_diagram — render a Mermaid diagram into a live, auto-refreshing browser
 * preview the user can watch while the agent edits it.
 *
 * Contract:
 *   - `source` present  -> overwrite Docs/diagrams/<id>.mmd (atomic) and (re)preview it
 *   - `source` omitted  -> open/watch an EXISTING Docs/diagrams/<id>.mmd, never write
 * The `.mmd` file is the single source of truth. Rendering happens CLIENT-SIDE in the
 * browser (vendored mermaid.min.js) — Foreman renders nothing and ships no Chromium.
 *
 * Failure is returned as a tool result with isError:true (the `.mmd` path is preserved),
 * never as a thrown protocol error.
 */
import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"
import { toKeyValue } from "../lib/toon.js"
import {
  ensureDiagramServer,
  registerDiagram,
  diagramUrl,
  isValidDiagramId,
  hasActiveConnections,
} from "../lib/diagramServer.js"

export interface PreviewDiagramArgs {
  source?: string
  id?: string
  title?: string
  theme?: "default" | "neutral" | "dark" | "forest" | "base"
  open?: boolean
}

interface PreviewResult {
  text: string
  isError?: boolean
}

function openBrowser(url: string): void {
  const platform = process.platform
  let cmd: string
  let cmdArgs: string[]
  if (platform === "darwin") {
    cmd = "open"
    cmdArgs = [url]
  } else if (platform === "win32") {
    cmd = "cmd"
    cmdArgs = ["/c", "start", "", url]
  } else {
    cmd = "xdg-open"
    cmdArgs = [url]
  }
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true })
    child.on("error", () => {
      /* opener not available — silently skip; user has the URL */
    })
    child.unref()
  } catch {
    /* ignore */
  }
}

export async function previewDiagram(
  args: PreviewDiagramArgs,
  docsDir: string
): Promise<PreviewResult> {
  const id = args.id ?? "diagram"
  if (!isValidDiagramId(id)) {
    return {
      text: `error: invalid id "${id}". Use ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase, no slashes).`,
      isError: true,
    }
  }

  const diagramsDir = path.join(docsDir, "diagrams")
  const filePath = path.join(diagramsDir, `${id}.mmd`)
  const theme = args.theme ?? "default"

  let status: "wrote" | "updated" | "opened"

  try {
    if (typeof args.source === "string" && args.source.length > 0) {
      await fs.mkdir(diagramsDir, { recursive: true })
      let existed = false
      try {
        await fs.access(filePath)
        existed = true
      } catch {
        /* new file */
      }
      // Atomic write: .tmp then rename (mirrors lib/ledger.ts:255).
      const tmpPath = `${filePath}.tmp`
      await fs.writeFile(tmpPath, args.source, "utf-8")
      await fs.rename(tmpPath, filePath)
      status = existed ? "updated" : "wrote"
    } else {
      // No source — must already exist.
      try {
        await fs.access(filePath)
      } catch {
        return {
          text: `error: no source provided and ${filePath} does not exist. Pass "source" to create it.`,
          isError: true,
        }
      }
      status = "opened"
    }
  } catch (err) {
    return {
      text: `error: failed to write ${filePath}: ${(err as Error).message}`,
      isError: true,
    }
  }

  // Kill switch: write the artifact but do not start a listener.
  if (process.env.FOREMAN_PREVIEW === "0") {
    return {
      text: toKeyValue({
        source: filePath,
        status,
        preview: "disabled (FOREMAN_PREVIEW=0)",
      }),
    }
  }

  let port: number
  let token: string
  try {
    const srv = await ensureDiagramServer()
    port = srv.port
    token = srv.token
    registerDiagram(id, filePath)
  } catch (err) {
    return {
      text: toKeyValue({
        source: filePath,
        status,
        preview: `unavailable: ${(err as Error).message}`,
      }),
      isError: true,
    }
  }

  const url = diagramUrl(port, token, id, theme, args.title)

  // Only auto-open a tab when there isn't already a live one for this id — a
  // re-call to update the same diagram refreshes the existing tab over SSE
  // instead of spawning a new one (the workshop loop).
  const alreadyLive = hasActiveConnections(id)
  const shouldOpen =
    args.open !== false &&
    !process.env.FOREMAN_NO_OPEN &&
    !process.env.CI &&
    !alreadyLive
  if (shouldOpen) openBrowser(url)

  return {
    text:
      toKeyValue({
        preview_url: url,
        source: filePath,
        status,
        backend: "local (client-side mermaid, loopback only)",
      }) +
      "\n\n" +
      "The preview auto-refreshes when " +
      `${path.basename(filePath)} changes — re-call preview_diagram with the same id, ` +
      "or edit the .mmd directly, to workshop it live.",
  }
}
