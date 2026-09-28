// 0.6.38 (field report 2026-09-27): Foreman trusts the OS certificate store so teams with their
// own PKI reach internal services without an env var; nothing disables verification.
import { describe, it, expect } from "vitest"
import { trustSystemCa, describeFetchError, systemCaState } from "../src/lib/systemCa.js"

const fakeTls = (system: string[], current: string[]) => {
  let set: string[] | undefined
  return {
    api: { getCACertificates: (t?: string) => (t === "system" ? system : current), setDefaultCACertificates: (c: string[]) => { set = c } } as never,
    get set() { return set },
  }
}

describe("OS certificate store", () => {
  it("adds the OS store to the current default, deduplicated", () => {
    const t = fakeTls(["A", "B"], ["B", "C"])
    const s = trustSystemCa({}, t.api)
    expect(s).toEqual({ status: "on", system: 2, total: 3 })
    expect(t.set).toEqual(["B", "C", "A"])
    expect(systemCaState()).toEqual(s)
  })

  it("FOREMAN_TRUST_SYSTEM_CA=0 leaves the default alone", () => {
    const t = fakeTls(["A"], ["B"])
    expect(trustSystemCa({ FOREMAN_TRUST_SYSTEM_CA: "0" }, t.api).status).toBe("off")
    expect(t.set).toBeUndefined()
  })

  it("an older Node without the API is told how to get the same result", () => {
    const s = trustSystemCa({}, {} as never)
    expect(s.status).toBe("unavailable")
    expect(JSON.stringify(s)).toContain("NODE_USE_SYSTEM_CA=1")
  })

  it("a certificate failure names its cause and the fix; other failures stay plain", () => {
    trustSystemCa({}, fakeTls(["A"], ["B"]).api)
    const certErr = Object.assign(new Error("fetch failed"), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", message: "unable to get local issuer certificate" } })
    const text = describeFetchError(certErr)
    expect(text).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
    expect(text).toContain("NODE_EXTRA_CA_CERTS")
    const dns = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" } })
    expect(describeFetchError(dns)).toBe("fetch failed: getaddrinfo ENOTFOUND x")
  })
})
