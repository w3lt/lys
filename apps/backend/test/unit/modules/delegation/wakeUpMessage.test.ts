import { jobSchema, type Job } from "@lys/share"
import { describe, expect, it } from "vitest"
import { formatWakeUpMessage } from "../../../../src/modules/delegation/wakeUpMessage"
import {
  createFixtureUuidV7,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"

/**
 * Creates a job that is still working.
 *
 * @param number - The job's number in its conversation.
 * @param agentCode - Code of the agent that works on it.
 * @returns The validated job; its identities follow from its number.
 */
function createWorkingJob(number: number, agentCode: string): Job {
  return jobSchema.parse({
    id: createFixtureUuidV7(number * 10),
    number,
    agentCode,
    title: "Collect moth news",
    state: "working",
    latestNote: null,
    replyId: createFixtureUuidV7(number * 10 + 1),
    jobCallIds: [createFixtureUuidV7(number * 10 + 2)],
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  })
}

describe("formatWakeUpMessage", () => {
  it("says that reports arrived and that no job is still working when none is", () => {
    expect(formatWakeUpMessage([])).toBe(
      "Reports from your jobs arrived. No job is still working."
    )
  })

  it("names each job that is still working by its number and its agent's code, in the order given", () => {
    const researchJob = createWorkingJob(2, "research-agent")
    const newsJob = createWorkingJob(3, "news-agent")

    expect(formatWakeUpMessage([researchJob, newsJob])).toBe(
      "Reports from your jobs arrived. Still working: job 2 (research-agent), job 3 (news-agent)."
    )
  })

  it("names a single working job without a list separator", () => {
    const newsJob = createWorkingJob(1, "news-agent")

    expect(formatWakeUpMessage([newsJob])).toBe(
      "Reports from your jobs arrived. Still working: job 1 (news-agent)."
    )
  })
})
