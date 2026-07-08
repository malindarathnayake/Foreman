import { describe, it, expect } from "vitest"
import { PLAYBOOK } from "../src/tools/invokeWorker.js"
import { FAILURE_STAGES } from "../src/lib/eventsSidecar.js"

// The closed failure taxonomy has two hand-maintained mirrors of one union: the compile-time
// Record<FailureStage,string> (PLAYBOOK) and the runtime Set validated at every sidecar append
// (FAILURE_STAGES). A stage added to one but not the other passes tsc yet crashes at append
// time — this test is the byte-for-byte parity guard (spec Testing Strategy).
describe("failure-stage taxonomy parity", () => {
  const playbookKeys = Object.keys(PLAYBOOK).sort()
  const setMembers = Array.from(FAILURE_STAGES).sort()

  it("both mirrors hold exactly 21 stages", () => {
    expect(playbookKeys.length).toBe(21)
    expect(setMembers.length).toBe(21)
  })

  it("PLAYBOOK keys and FAILURE_STAGES members are byte-for-byte identical", () => {
    expect(playbookKeys).toEqual(setMembers)
  })

  it("every stage crosses both mirrors (append-time enum accepts every PLAYBOOK stage, and vice versa)", () => {
    for (const stage of playbookKeys) expect(FAILURE_STAGES.has(stage)).toBe(true)
    for (const stage of setMembers) expect(Object.prototype.hasOwnProperty.call(PLAYBOOK, stage)).toBe(true)
  })
})
