/**
 * Live diagram preview server for Foreman's `preview_diagram` tool.
 *
 * This is Foreman's FIRST and ONLY network listener. It is deliberately narrow:
 *   - binds 127.0.0.1 only (never 0.0.0.0)
 *   - every private route is gated by a per-process unguessable token
 *   - every request is Host-validated (DNS-rebinding defense, à la Jupyter/Vite)
 *   - no CORS headers are ever emitted
 *   - it renders NOTHING server-side: it serves the .mmd source + a static page
 *     that runs the vendored mermaid.min.js CLIENT-SIDE. No Chromium.
 *
 * Live reload is one-way (server -> browser) via SSE, so we need no websocket dep.
 * The server watches the diagrams DIRECTORY (not a file handle) so it survives the
 * atomic temp->rename writes used elsewhere in Foreman (see lib/ledger.ts:255).
 *
 * IMPORTANT: this module must never write to stdout — stdout is the MCP protocol
 * channel (StdioServerTransport). All logging goes to stderr.
 */
import http from "http"
import { createReadStream } from "fs"
import fs from "fs/promises"
import { watch, type FSWatcher } from "fs"
import path from "path"
import crypto from "crypto"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT_START = 3939
const PORT_END = 3949
const HEARTBEAT_MS = 20_000
const DEBOUNCE_MS = 80

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
}

// CSP: client-side mermaid runs under script-src 'self' with NO 'unsafe-eval'
// (verified: the vendored bundle has no eval/new Function call path that fires in
// a browser, no dynamic import, no WASM, no workers). 'unsafe-inline' in style-src
// is required because mermaid injects a <style> block + foreignObject labels.
const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'none'"

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidDiagramId(id: string): boolean {
  return ID_RE.test(id)
}

interface DiagramState {
  filePath: string
  clients: Set<http.ServerResponse>
  debounceTimer?: NodeJS.Timeout
}

interface RunningServer {
  server: http.Server
  port: number
  token: string
  heartbeat: NodeJS.Timeout
  watchers: Map<string, FSWatcher> // dir -> watcher
  diagrams: Map<string, DiagramState> // id -> state
  assetsDir: string
}

let running: RunningServer | null = null

function elog(msg: string): void {
  // stderr only — never stdout (MCP channel)
  console.error(`[foreman:preview] ${msg}`)
}

/** Resolve the bundled preview assets dir (dist/preview in prod, src/preview in dev). */
async function resolveAssetsDir(): Promise<string> {
  const primary = path.resolve(__dirname, "..", "preview") // dist/lib -> dist/preview ; src/lib -> src/preview
  try {
    await fs.access(path.join(primary, "template.html"))
    return primary
  } catch {
    // Fallback: dist build that didn't copy assets — reach back to source.
    const fallback = path.resolve(__dirname, "..", "..", "src", "preview")
    return fallback
  }
}

function findAvailablePort(start = PORT_START, end = PORT_END): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > end) {
        reject(new Error(`no free port in ${start}-${end}`))
        return
      }
      const probe = http.createServer()
      probe.once("error", () => {
        probe.close(() => tryPort(port + 1))
      })
      probe.once("listening", () => {
        probe.close(() => resolve(port))
      })
      probe.listen(port, "127.0.0.1")
    }
    tryPort(start)
  })
}

function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false
  return (
    hostHeader === `127.0.0.1:${port}` ||
    hostHeader === `localhost:${port}` ||
    hostHeader === `[::1]:${port}`
  )
}

function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true // legitimately absent on GET navigation / EventSource
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://[::1]:${port}`
  )
}

function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

function setSecurityHeaders(res: http.ServerResponse, contentType: string): void {
  res.setHeader("Content-Type", contentType)
  res.setHeader("Content-Security-Policy", CSP)
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Cache-Control", "no-store")
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function notifyClients(state: DiagramState): void {
  for (const res of state.clients) {
    res.write("data: reload\n\n")
  }
}

function scheduleReload(rs: RunningServer, id: string): void {
  const state = rs.diagrams.get(id)
  if (!state) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = undefined
    notifyClients(state)
  }, DEBOUNCE_MS)
}

function ensureDirWatch(rs: RunningServer, dir: string): void {
  if (rs.watchers.has(dir)) return
  try {
    const w = watch(dir, (_event, filename) => {
      if (!filename) {
        // Some platforms omit the filename — reload everything in this dir.
        for (const [id, st] of rs.diagrams) {
          if (path.dirname(st.filePath) === dir) scheduleReload(rs, id)
        }
        return
      }
      const name = filename.toString()
      if (!name.endsWith(".mmd")) return // ignore .mmd.tmp and others
      const id = name.slice(0, -4)
      const st = rs.diagrams.get(id)
      if (st && path.dirname(st.filePath) === dir) scheduleReload(rs, id)
    })
    rs.watchers.set(dir, w)
  } catch (err) {
    elog(`watch failed for ${dir}: ${(err as Error).message}`)
  }
}

async function serveAsset(rs: RunningServer, assetName: string, res: http.ServerResponse): Promise<void> {
  // assetName is a fixed allowlist entry — never user-derived path.
  const filePath = path.join(rs.assetsDir, assetName)
  const ext = path.extname(assetName)
  try {
    await fs.access(filePath)
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("asset not found")
    return
  }
  setSecurityHeaders(res, ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream")
  // Assets are immutable within a session; allow caching to avoid re-shipping 3MB.
  res.setHeader("Cache-Control", "private, max-age=86400")
  res.writeHead(200)
  createReadStream(filePath).pipe(res)
}

async function handleViewPage(
  rs: RunningServer,
  id: string,
  query: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const state = rs.diagrams.get(id)
  if (!state) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("diagram not registered")
    return
  }
  const theme = query.get("theme") ?? "default"
  const title = query.get("title") ?? id
  const tplPath = path.join(rs.assetsDir, "template.html")
  let tpl: string
  try {
    tpl = await fs.readFile(tplPath, "utf-8")
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" })
    res.end("template missing")
    return
  }
  const html = tpl
    .replaceAll("{{ID}}", escapeHtml(id))
    .replaceAll("{{TOKEN}}", escapeHtml(rs.token))
    .replaceAll("{{THEME}}", escapeHtml(theme))
    .replaceAll("{{TITLE}}", escapeHtml(title))
  setSecurityHeaders(res, "text/html; charset=utf-8")
  res.writeHead(200)
  res.end(html)
}

async function handleSource(rs: RunningServer, id: string, res: http.ServerResponse): Promise<void> {
  const state = rs.diagrams.get(id)
  if (!state) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
    return
  }
  try {
    const text = await fs.readFile(state.filePath, "utf-8")
    setSecurityHeaders(res, "text/plain; charset=utf-8")
    res.writeHead(200)
    res.end(text)
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("source not found")
  }
}

function handleEvents(rs: RunningServer, id: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = rs.diagrams.get(id)
  if (!state) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
    return
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  })
  res.write("retry: 2000\n\n")
  state.clients.add(res)
  req.on("close", () => {
    state.clients.delete(res)
  })
}

function requestHandler(rs: RunningServer) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      // DNS-rebinding defense: Host + Origin checks on EVERY request.
      if (!hostAllowed(req.headers.host, rs.port)) {
        res.writeHead(403, { "Content-Type": "text/plain" })
        res.end("forbidden host")
        return
      }
      if (!originAllowed(req.headers.origin, rs.port)) {
        res.writeHead(403, { "Content-Type": "text/plain" })
        res.end("forbidden origin")
        return
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${rs.port}`)
      const segs = url.pathname.split("/").filter(Boolean)

      // Static assets (tokenless, no secrets): /assets/<name>
      if (segs[0] === "assets" && segs.length === 2) {
        const allowed = new Set(["mermaid.min.js", "app.js", "style.css", "mermaid.LICENSE"])
        const name = segs[1]
        if (!allowed.has(name)) {
          res.writeHead(404, { "Content-Type": "text/plain" })
          res.end("not found")
          return
        }
        await serveAsset(rs, name === "mermaid.LICENSE" ? "mermaid.LICENSE" : name, res)
        return
      }

      // Private routes: /t/<token>/<kind>/<id>
      if (segs[0] === "t" && segs.length >= 3) {
        if (!tokenMatches(segs[1], rs.token)) {
          res.writeHead(403, { "Content-Type": "text/plain" })
          res.end("forbidden")
          return
        }
        const kind = segs[2]
        const id = segs[3] ?? ""
        if (!isValidDiagramId(id)) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("bad id")
          return
        }
        if (kind === "view") return void (await handleViewPage(rs, id, url.searchParams, res))
        if (kind === "api" && segs[3] === "source" && segs[4]) {
          // /t/<token>/api/source/<id>
          const sid = segs[4]
          if (!isValidDiagramId(sid)) {
            res.writeHead(400, { "Content-Type": "text/plain" })
            res.end("bad id")
            return
          }
          return void (await handleSource(rs, sid, res))
        }
        if (kind === "events") return void handleEvents(rs, id, req, res)
      }

      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found")
    } catch (err) {
      elog(`request error: ${(err as Error).message}`)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" })
      }
      res.end("server error")
    }
  }
}

/** Start (or reuse) the singleton preview server. Returns its port + token. */
export async function ensureDiagramServer(): Promise<{ port: number; token: string }> {
  if (running) return { port: running.port, token: running.token }

  const assetsDir = await resolveAssetsDir()
  const port = await findAvailablePort()
  const token = crypto.randomBytes(16).toString("hex")

  const server = http.createServer()
  const rs: RunningServer = {
    server,
    port,
    token,
    heartbeat: setInterval(() => {
      for (const state of rs.diagrams.values()) {
        for (const res of state.clients) res.write(": heartbeat\n\n")
      }
    }, HEARTBEAT_MS),
    watchers: new Map(),
    diagrams: new Map(),
    assetsDir,
  }
  // Don't let the heartbeat keep the event loop alive on its own.
  rs.heartbeat.unref?.()
  server.on("request", requestHandler(rs))

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })

  running = rs
  elog(`live preview server on http://127.0.0.1:${port} (token-gated, loopback only)`)
  return { port, token }
}

/** Register a diagram id -> file path and begin watching its directory. */
export function registerDiagram(id: string, filePath: string): void {
  if (!running) return
  const existing = running.diagrams.get(id)
  if (existing) {
    existing.filePath = filePath
  } else {
    running.diagrams.set(id, { filePath, clients: new Set() })
  }
  ensureDirWatch(running, path.dirname(filePath))
}

/** Build the user-facing URL for a registered diagram. */
export function diagramUrl(port: number, token: string, id: string, theme?: string, title?: string): string {
  const params = new URLSearchParams()
  if (theme && theme !== "default") params.set("theme", theme)
  if (title) params.set("title", title)
  const qs = params.toString()
  return `http://127.0.0.1:${port}/t/${token}/view/${id}${qs ? `?${qs}` : ""}`
}

/** Tear everything down (tests + shutdown). Safe to call when not running. */
export async function closeDiagramServer(): Promise<void> {
  if (!running) return
  const rs = running
  running = null
  clearInterval(rs.heartbeat)
  for (const state of rs.diagrams.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    for (const res of state.clients) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }
  for (const w of rs.watchers.values()) {
    try {
      w.close()
    } catch {
      /* ignore */
    }
  }
  await new Promise<void>((resolve) => rs.server.close(() => resolve()))
}

/** True if a live browser tab is currently connected (SSE) for this diagram id. */
export function hasActiveConnections(id: string): boolean {
  if (!running) return false
  const st = running.diagrams.get(id)
  return st ? st.clients.size > 0 : false
}

/** Test/diagnostic helper. */
export function isRunning(): boolean {
  return running !== null
}
