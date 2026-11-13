import { describe, expect, it } from "vitest"
import ReplyStopRequests from "../../../../src/modules/delegation/replyStopRequests"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Identity of the reply most cases ask to stop. */
const REPLY_ID = createFixtureUuidV7(1)

/** Identity of another reply. */
const OTHER_REPLY_ID = createFixtureUuidV7(2)

describe("ReplyStopRequests", () => {
  it("answers the first requester of a reply once, and nothing afterwards", () => {
    const stopRequests = new ReplyStopRequests()
    stopRequests.addStopRequest(REPLY_ID, "delegator")
    stopRequests.addStopRequest(REPLY_ID, "person")

    expect(stopRequests.removeStopRequest(REPLY_ID)).toBe("delegator")
    expect(stopRequests.removeStopRequest(REPLY_ID)).toBeUndefined()
  })

  it("keeps the person as the requester when the delegator asks afterwards", () => {
    const stopRequests = new ReplyStopRequests()
    stopRequests.addStopRequest(REPLY_ID, "person")
    stopRequests.addStopRequest(REPLY_ID, "delegator")

    expect(stopRequests.removeStopRequest(REPLY_ID)).toBe("person")
  })

  it("answers nothing for a reply nobody asked to stop", () => {
    const stopRequests = new ReplyStopRequests()
    stopRequests.addStopRequest(REPLY_ID, "person")

    expect(stopRequests.removeStopRequest(OTHER_REPLY_ID)).toBeUndefined()
  })

  it("keeps the requests of two replies apart", () => {
    const stopRequests = new ReplyStopRequests()
    stopRequests.addStopRequest(REPLY_ID, "delegator")
    stopRequests.addStopRequest(OTHER_REPLY_ID, "person")

    expect(stopRequests.removeStopRequest(REPLY_ID)).toBe("delegator")
    expect(stopRequests.removeStopRequest(OTHER_REPLY_ID)).toBe("person")
  })

  it("takes a new first requester once a reply's request was removed", () => {
    const stopRequests = new ReplyStopRequests()
    stopRequests.addStopRequest(REPLY_ID, "delegator")
    stopRequests.removeStopRequest(REPLY_ID)

    stopRequests.addStopRequest(REPLY_ID, "person")

    expect(stopRequests.removeStopRequest(REPLY_ID)).toBe("person")
  })
})
