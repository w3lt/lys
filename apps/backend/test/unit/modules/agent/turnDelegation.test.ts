import { jobSchema, type Job } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  buildDelegationOffer,
  type ConversationDelegation
} from "../../../../src/modules/agent/turnDelegation"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** A main conversation no job was started from. */
const MAIN_CONVERSATION: ConversationDelegation = Object.freeze({
  kind: "main",
  jobNumber: null,
  delegatorAgentCode: null,
  jobs: Object.freeze([])
})

/** Job 3 of a main conversation of Caliginia. */
const JOB_CONVERSATION: ConversationDelegation = Object.freeze({
  kind: "job",
  jobNumber: 3,
  delegatorAgentCode: "caliginia",
  jobs: Object.freeze([])
})

/**
 * Finds the display name of the built-in agents only.
 *
 * @param code - Agent code.
 * @returns `Caliginia` for `caliginia`; undefined for every other code.
 */
function findBuiltInAgentName(code: string): string | undefined {
  return code === "caliginia" ? "Caliginia" : undefined
}

describe("buildDelegationOffer", () => {
  it.each([
    ["a main conversation whose offer names delegate_work", true, true],
    ["a main conversation whose offer leaves it out", false, false]
  ])(
    "lets %s delegate only when the offer names delegate_work",
    (_label, offersDelegateWork, mayDelegate) => {
      expect(
        buildDelegationOffer(
          MAIN_CONVERSATION,
          offersDelegateWork,
          findBuiltInAgentName
        )
      ).toEqual({ mayDelegate, hasJobs: false, job: undefined })
    }
  )

  it("never lets a job delegate, and names its number and its delegator", () => {
    const findAgentName = vi.fn(findBuiltInAgentName)

    const offer = buildDelegationOffer(JOB_CONVERSATION, true, findAgentName)

    expect(offer).toEqual({
      mayDelegate: false,
      hasJobs: false,
      job: { delegatorName: "Caliginia", jobNumber: 3 }
    })
    expect(findAgentName).toHaveBeenCalledExactlyOnceWith("caliginia")
  })

  it("names a job's delegator by its code when no agent has the code", () => {
    expect(
      buildDelegationOffer(JOB_CONVERSATION, false, () => undefined).job
    ).toEqual({ delegatorName: "caliginia", jobNumber: 3 })
  })

  it("says a conversation has jobs once a job was started from it", () => {
    /** Job started from the main conversation of the cases that have one. */
    const researchJob: Job = jobSchema.parse({
      id: createFixtureUuidV7(2),
      number: 1,
      agentCode: "researcher",
      title: "Hologram news",
      state: "working",
      latestNote: null,
      replyId: createFixtureUuidV7(4),
      jobCallIds: [createFixtureUuidV7(3)],
      createdAt: "2026-11-10T10:00:00.000Z",
      updatedAt: "2026-11-10T10:00:00.000Z"
    })

    /** A main conversation one job was started from. */
    const mainConversationWithJob: ConversationDelegation = Object.freeze({
      ...MAIN_CONVERSATION,
      jobs: Object.freeze([researchJob])
    })

    expect(
      buildDelegationOffer(mainConversationWithJob, true, findBuiltInAgentName)
    ).toEqual({ mayDelegate: true, hasJobs: true, job: undefined })
  })

  it("returns a frozen offer and job", () => {
    const offer = buildDelegationOffer(
      JOB_CONVERSATION,
      false,
      findBuiltInAgentName
    )

    expect(Object.isFrozen(offer)).toBe(true)
    expect(Object.isFrozen(offer.job)).toBe(true)
  })
})
