/**
 * Trust the operating system's certificate store (0.6.38).
 *
 * Field report 2026-09-27: contract_probe could not reach an internal Graylog until the
 * operator found NODE_USE_SYSTEM_CA=1, put it in Foreman's env and reconnected — and the
 * contract gate, correctly, cannot be overridden. Node verifies TLS against its bundled
 * Mozilla list by default, not the OS store, so every enterprise or SME with its own PKI
 * hit the same wall. Foreman is built for those teams, so it adds the OS store to the
 * default trust at startup. This is what a browser or `git` on the same machine already
 * trusts; nothing is disabled, and verification still fails for a certificate no store
 * vouches for. There is no skip-verification option [CWE-295].
 *
 * Node >= 22.19 / 24.5 exposes tls.getCACertificates and tls.setDefaultCACertificates;
 * global fetch honours the changed default (verified: restricting the default broke a
 * public site with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, merging the store back fixed it).
 * Older Nodes keep their behaviour and are told how to get the same result.
 * FOREMAN_TRUST_SYSTEM_CA=0 opts out.
 */
import tls from "node:tls"

export type SystemCaState =
  | { status: "on"; system: number; total: number }
  | { status: "off"; reason: string }
  | { status: "unavailable"; reason: string }

let state: SystemCaState | undefined

type TlsWithCa = typeof tls & {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

export function trustSystemCa(env: NodeJS.ProcessEnv = process.env, api: TlsWithCa = tls as TlsWithCa): SystemCaState {
  if (env.FOREMAN_TRUST_SYSTEM_CA?.trim() === "0") {
    state = { status: "off", reason: "FOREMAN_TRUST_SYSTEM_CA=0" }
    return state
  }
  if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") {
    state = {
      status: "unavailable",
      reason: `Node ${process.version} cannot add the OS store at runtime (needs 22.19+ or 24.5+); start Foreman with NODE_USE_SYSTEM_CA=1, or NODE_EXTRA_CA_CERTS=<ca.pem>`,
    }
    return state
  }
  try {
    // "default" is the bundled list plus NODE_EXTRA_CA_CERTS; the OS store is added to it.
    const current = api.getCACertificates("default")
    const system = api.getCACertificates("system")
    const merged = [...new Set([...current, ...system])]
    api.setDefaultCACertificates(merged)
    state = { status: "on", system: system.length, total: merged.length }
  } catch (err) {
    state = { status: "unavailable", reason: `the OS store could not be read (${err instanceof Error ? err.message : String(err)}); set NODE_EXTRA_CA_CERTS=<ca.pem>` }
  }
  return state
}

export function systemCaState(): SystemCaState | undefined {
  return state
}

/** Certificate failures that the OS store or an extra CA file would fix. */
const CERT_CODES = /UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED/

/** A fetch failure's real cause, with a hint when it is a trust problem. */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? ""
  const base = cause?.message ? `${err.message}: ${cause.message}${code && !cause.message.includes(code) ? ` (${code})` : ""}` : err.message
  if (!CERT_CODES.test(code) && !CERT_CODES.test(base)) return base
  const s = state
  const trust = s?.status === "on"
    ? "Foreman already trusts the OS certificate store, so the issuing CA is in neither it nor Node's bundle: install the CA in the OS store, or set NODE_EXTRA_CA_CERTS=<ca.pem> in the server env and reconnect"
    : s?.status === "off"
      ? "Foreman's OS-store trust is off (FOREMAN_TRUST_SYSTEM_CA=0); remove it, or set NODE_EXTRA_CA_CERTS=<ca.pem>, and reconnect"
      : `${s?.reason ?? "the OS store is not trusted"}; then reconnect`
  return `${base} — certificate not trusted. ${trust}.`
}
