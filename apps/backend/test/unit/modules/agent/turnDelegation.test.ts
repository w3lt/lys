import { describe, expect, it } from "vitest"
import {
  NO_TURN_DELEGATION,
  type JobMessageDraft
} from "../../../../src/modules/agent/turnDelegation"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** A job message a `delegate_work` call could ask to send. */
const JOB_MESSAGE_DRAFT: JobMessageDraft = Object.freeze({
  agentCode: "researcher",
  title: "Hologram news",
  instructions: "Collect this week's news about holograms.",
  jobNumber: undefined,
  toolCallId: createFixtureUuidV7(1)
})

/** Cancellation of a stop that no case aborts. */
const { signal: STOP_SIGNAL } = new AbortController()

/** One delegation callback, with the call a delegation tool would make of it. */
type DelegationCallCase = [label: string, callDelegation: () => unknown]

describe("NO_TURN_DELEGATION", () => {
  it("allows nothing of delegation", () => {
    expect(NO_TURN_DELEGATION.offer).toEqual({
      mayDelegate: false,
      hasJobs: false,
      job: undefined
    })
  })

  it.each<DelegationCallCase>([
    [
      "send a job message",
      () => NO_TURN_DELEGATION.createJobMessage(JOB_MESSAGE_DRAFT)
    ],
    [
      "store a progress note",
      () =>
        NO_TURN_DELEGATION.createProgressNote("Two of five sources are read.")
    ],
    ["stop a job", () => NO_TURN_DELEGATION.stopJob(1, STOP_SIGNAL)]
  ])("throws when it is asked to %s", (_label, callDelegation) => {
    expect(callDelegation).toThrow("This turn takes no part in delegation")
  })
})
