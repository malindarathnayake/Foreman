import { describe, it, expect } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js"

// 0.6.34: hosts defer tool loading, so server instructions may be the only Foreman text a
// session sees. They must be conditional: Foreman is registered user-wide.
describe("server instructions", () => {
  it("reach the client in the initialize response", async () => {
    const server = await createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientTransport)
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("fit the self-contained prefix and never make registration an instruction to start", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512)
    expect(SERVER_INSTRUCTIONS).toMatch(/only when/)
    expect(SERVER_INSTRUCTIONS).toMatch(/not a reason to start/)
    expect(SERVER_INSTRUCTIONS).toMatch(/seats: ignore Foreman state/)
  })
})
