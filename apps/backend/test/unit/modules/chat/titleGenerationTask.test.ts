import type { ChatGenerationEvent } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import type { TitleGenerationOptions } from "../../../../src/modules/chat/chatService"
import createTitleGenerationTask, {
  type CreateTitleGenerationTaskOptions
} from "../../../../src/modules/chat/titleGenerationTask"
import { TitleGenerationOutputError } from "../../../../src/utils/errors"
import {
  createTestFastify,
  type CapturedLogRecord
} from "../../support/fastifyTestApp"

/** Documented `titleGenerationOutcome` values of the title task's log records. */
type TitleGenerationOutcome =
  | "retrying"
  | "title-not-generated"
  | "abandoned"
  | "already-titled"
  | "title-not-saved"

/**
 * Selects the captured records logged for one title-generation outcome.
 *
 * @param logs - Records captured from one test application.
 * @param outcome - `titleGenerationOutcome` value to select.
 * @returns The matching records in write order.
 */
function findOutcomeRecords(
  logs: readonly CapturedLogRecord[],
  outcome: TitleGenerationOutcome
): CapturedLogRecord[] {
  return logs.filter((record) => record.titleGenerationOutcome === outcome)
}

/** Test-controlled parts of one title task run. */
type TitleTaskScenario = Readonly<{
  /** Title request behavior. */
  generateTitle: CreateTitleGenerationTaskOptions["generateTitle"]
  /** Inclusive attempt limit; 3 by default. */
  titleGenerationMaxAttempts?: number
  /** Shutdown cancellation owned by the case; a fresh signal by default. */
  abortSignal?: AbortSignal
  /** Conditional title storage; saves the title unchanged by default. */
  updateConversationTitle?: CreateTitleGenerationTaskOptions["updateConversationTitle"]
}>

/**
 * Creates a title generator that answers each request from a script.
 *
 * @param outcomes - Title or failure for the first, second, ... request.
 * @returns A mock generator that rejects once the script is exhausted.
 */
function createScriptedTitleGenerator(...outcomes: (string | Error)[]) {
  const generateTitle = vi.fn<
    (options: TitleGenerationOptions) => Promise<string>
  >(async () => {
    throw new Error("Unexpected title request")
  })
  for (const outcome of outcomes) {
    if (outcome instanceof Error) {
      generateTitle.mockRejectedValueOnce(outcome)
    } else {
      generateTitle.mockResolvedValueOnce(outcome)
    }
  }
  return generateTitle
}

/**
 * Runs one title task to settlement and records its effects.
 *
 * @param scenario - Generator, limit, cancellation, and storage behavior.
 * @returns The sent events, storage calls, and captured logs.
 * @throws If the task rejects, which its contract forbids.
 */
async function getTitleTaskOutcome(scenario: TitleTaskScenario) {
  const { app, logs } = createTestFastify()
  const events: ChatGenerationEvent[] = []
  const updateConversationTitle = vi.fn(
    scenario.updateConversationTitle ?? ((title: string) => title)
  )
  await createTitleGenerationTask({
    generateTitle: scenario.generateTitle,
    userMessageContent: "Plan my trip to Hanoi",
    model: "qwen/qwen3-8b",
    abortSignal: scenario.abortSignal ?? new AbortController().signal,
    sendEvent: (event) => {
      events.push(event)
    },
    logger: app.log,
    titleGenerationMaxAttempts: scenario.titleGenerationMaxAttempts ?? 3,
    updateConversationTitle
  })
  return { events, updateConversationTitle, logs }
}

describe("createTitleGenerationTask", () => {
  it("requests a title for the user message with the chat model and signal", async () => {
    const abortSignal = new AbortController().signal
    const generateTitle = createScriptedTitleGenerator("Hanoi trip")

    await getTitleTaskOutcome({ generateTitle, abortSignal })

    expect(generateTitle).toHaveBeenCalledExactlyOnceWith({
      message: "Plan my trip to Hanoi",
      model: "qwen/qwen3-8b",
      signal: abortSignal
    })
  })

  it("saves the generated title and sends the saved value", async () => {
    const run = await getTitleTaskOutcome({
      generateTitle: createScriptedTitleGenerator("  Hanoi trip "),
      updateConversationTitle: () => "Hanoi trip"
    })

    expect(run.updateConversationTitle).toHaveBeenCalledWith("  Hanoi trip ")
    expect(run.events).toEqual([{ type: "title", title: "Hanoi trip" }])
  })

  it("requests another title only after unusable output, within the limit", async () => {
    const generateTitle = createScriptedTitleGenerator(
      new TitleGenerationOutputError("blank"),
      new TitleGenerationOutputError("not JSON"),
      "Hanoi trip"
    )

    const run = await getTitleTaskOutcome({
      generateTitle,
      titleGenerationMaxAttempts: 3
    })

    expect(generateTitle).toHaveBeenCalledTimes(3)
    expect(run.events).toEqual([{ type: "title", title: "Hanoi trip" }])
    expect(findOutcomeRecords(run.logs, "retrying")).toEqual([
      expect.objectContaining({
        level: "debug",
        titleGenerationOutcome: "retrying",
        titleGenerationAttempts: 1,
        err: expect.objectContaining({ message: "blank" })
      }),
      expect.objectContaining({
        titleGenerationOutcome: "retrying",
        titleGenerationAttempts: 2,
        err: expect.objectContaining({ message: "not JSON" })
      })
    ])
  })

  it("gives up after the last permitted unusable reply without saving", async () => {
    const generateTitle = createScriptedTitleGenerator(
      new TitleGenerationOutputError("blank"),
      new TitleGenerationOutputError("too long")
    )

    const run = await getTitleTaskOutcome({
      generateTitle,
      titleGenerationMaxAttempts: 2
    })

    expect(generateTitle).toHaveBeenCalledTimes(2)
    expect(run.updateConversationTitle).not.toHaveBeenCalled()
    expect(run.events).toEqual([])
    expect(findOutcomeRecords(run.logs, "title-not-generated")).toEqual([
      expect.objectContaining({
        level: "warn",
        titleGenerationOutcome: "title-not-generated",
        titleGenerationAttempts: 2,
        err: expect.objectContaining({ message: "too long" })
      })
    ])
  })

  it("makes a single request when the limit is one", async () => {
    const generateTitle = createScriptedTitleGenerator(
      new TitleGenerationOutputError("blank")
    )

    const run = await getTitleTaskOutcome({
      generateTitle,
      titleGenerationMaxAttempts: 1
    })

    expect(generateTitle).toHaveBeenCalledOnce()
    expect(findOutcomeRecords(run.logs, "retrying")).toEqual([])
    expect(findOutcomeRecords(run.logs, "title-not-generated")).toHaveLength(1)
  })

  it("does not retry a request failure that is not unusable output", async () => {
    const generateTitle = createScriptedTitleGenerator(
      new Error("503 Service Unavailable")
    )

    const run = await getTitleTaskOutcome({ generateTitle })

    expect(generateTitle).toHaveBeenCalledOnce()
    expect(findOutcomeRecords(run.logs, "title-not-generated")).toEqual([
      expect.objectContaining({
        titleGenerationOutcome: "title-not-generated",
        titleGenerationAttempts: 1,
        err: expect.objectContaining({ message: "503 Service Unavailable" })
      })
    ])
    expect(run.events).toEqual([])
  })

  it("makes no request once shutdown has cancelled it", async () => {
    const cancellation = new AbortController()
    cancellation.abort(new Error("backend shutting down"))
    const generateTitle = createScriptedTitleGenerator()

    const run = await getTitleTaskOutcome({
      generateTitle,
      abortSignal: cancellation.signal
    })

    expect(generateTitle).not.toHaveBeenCalled()
    expect(findOutcomeRecords(run.logs, "abandoned")).toEqual([
      expect.objectContaining({
        level: "debug",
        titleGenerationOutcome: "abandoned",
        titleGenerationAttempts: 0,
        err: expect.objectContaining({ message: "backend shutting down" })
      })
    ])
    expect(run.events).toEqual([])
  })

  it("abandons generation instead of retrying when the failed request was cancelled", async () => {
    const cancellation = new AbortController()
    const generateTitle = vi.fn(async () => {
      cancellation.abort()
      throw new TitleGenerationOutputError("blank")
    })

    const run = await getTitleTaskOutcome({
      generateTitle,
      abortSignal: cancellation.signal
    })

    expect(generateTitle).toHaveBeenCalledOnce()
    expect(findOutcomeRecords(run.logs, "abandoned")).toEqual([
      expect.objectContaining({
        titleGenerationOutcome: "abandoned",
        titleGenerationAttempts: 1,
        err: expect.objectContaining({ message: "blank" })
      })
    ])
    expect(findOutcomeRecords(run.logs, "title-not-generated")).toEqual([])
  })

  it("sends no event when the conversation was renamed or deleted first", async () => {
    const run = await getTitleTaskOutcome({
      generateTitle: createScriptedTitleGenerator("Hanoi trip"),
      updateConversationTitle: () => undefined
    })

    expect(run.events).toEqual([])
    expect(findOutcomeRecords(run.logs, "already-titled")).toEqual([
      expect.objectContaining({
        level: "debug",
        titleGenerationOutcome: "already-titled",
        titleGenerationAttempts: 1
      })
    ])
  })

  it("logs a storage failure and sends no event", async () => {
    const storageFailure = new Error("simulated title storage failure")
    const run = await getTitleTaskOutcome({
      generateTitle: createScriptedTitleGenerator("Hanoi trip"),
      updateConversationTitle: () => {
        throw storageFailure
      }
    })

    expect(run.events).toEqual([])
    expect(findOutcomeRecords(run.logs, "title-not-saved")).toEqual([
      expect.objectContaining({
        level: "error",
        titleGenerationAttempts: 1,
        err: expect.objectContaining({ message: storageFailure.message })
      })
    ])
  })
})
