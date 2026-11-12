import type { MessageGenerationOptions } from "@lys/protocol"
import {
  CALIGINIA_AGENT_CODE,
  type ConversationAssistantMessageStatus,
  type ConversationAttachmentDraft
} from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import { describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import Agent, { type AgentProfile } from "../../../../src/modules/agent/agent"
import type { AgentRequestLimits } from "../../../../src/modules/agent/agentActivity"
import type { AgentStateReader } from "../../../../src/modules/agent/agentStateTools"
import type {
  ReplyModel,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../../../../src/modules/agent/replyModel"
import { NO_UNOFFERED_TOOLS } from "../../../../src/modules/agent/unofferedTools"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  ConversationTurnUserMessage
} from "../../../../src/modules/chat/persistence"
import ReplyGenerationRegistry from "../../../../src/modules/chat/replyGenerationRegistry"
import {
  startTurn,
  type StartTurnOptions,
  type TurnSettings,
  type TurnStartDependencies
} from "../../../../src/modules/chat/turnStart"
import type { TurnMcpTool } from "../../../../src/modules/mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../../../../src/modules/tool/builtIn/builtInTool"
import ToolApprovalService from "../../../../src/modules/toolApproval/toolApprovalService"
import { waitForSettlementOrAbort } from "../../../../src/utils/abort"
import {
  openConversationTestServices,
  type ConversationTestServices
} from "../../support/conversationDatabase"
import {
  createNewConversationTarget,
  createTurnUserMessage
} from "../../support/conversationFixtures"
import {
  createTestFastify,
  type CapturedLogDestination
} from "../../support/fastifyTestApp"
import { waitForMicrotasks } from "../../support/microtasks"
import {
  createRoomyReplyContextMeter,
  ROOMY_CONTEXT_LENGTH
} from "../../support/replyContextMeterFakes"
import {
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../support/scriptedBuiltInTool"
import {
  LEADER_STATE_TOOL_NAMES,
  READ_TEXT_FILE_TOOL
} from "../../support/toolFixtures"

/** Opens one reply stream for the agent that answers a case's turns. */
type OpenReplyStream = ReplyModel["openReplyStream"]

/** Model every case's settings select. */
const MODEL = "qwen/qwen3-8b"

/** Sampling and reply length controls of every case's settings. */
const GENERATION_OPTIONS: MessageGenerationOptions = Object.freeze({
  temperature: 0.4,
  replyCeiling: 128
})

/** MCP tools of every case's settings: none. */
const NO_MCP_TOOLS: readonly TurnMcpTool[] = Object.freeze([])

/**
 * Names of the tools every case's settings offer, in the order a model is
 * offered them: the client tool, then the backend tool.
 */
const SETTINGS_TOOL_NAMES: readonly string[] = Object.freeze([
  "read_text_file",
  "look_up_word"
])

/** Text of the message every new conversation of a case starts with. */
const FIRST_MESSAGE = "Plan my trip"

/** A text file the person attached, before its conversation numbers it. */
const NOTES_ATTACHMENT: ConversationAttachmentDraft = Object.freeze({
  kind: "text",
  name: "notes.md",
  sizeBytes: 18
})

/** A photo the person attached, before its conversation numbers it. */
const PHOTO_ATTACHMENT: ConversationAttachmentDraft = Object.freeze({
  kind: "image",
  name: "photo.png",
  sizeBytes: 33,
  mediaType: "image/png",
  width: 64,
  height: 32
})

/** Events of a model that answers `Hi` and ends its reply. */
const HI_REPLY: readonly ReplyStreamEvent[] = Object.freeze([
  { type: "text", content: "Hi" },
  { type: "finish", finishReason: "stop" }
])

/** Request limits of the agent under test: two replies at once, one waiting. */
const REQUEST_LIMITS: AgentRequestLimits = Object.freeze({
  slotCount: 2,
  waitingLimit: 1
})

/** Profile of the agent that answers every case's turns: a leader. */
const AGENT_PROFILE: AgentProfile = Object.freeze({
  code: CALIGINIA_AGENT_CODE,
  role: "leader",
  systemPrompt: "You are the test Caliginia.",
  requestLimits: REQUEST_LIMITS
})

/**
 * Fails an agent state read that no case arranges.
 *
 * @throws Always.
 */
function handleUnexpectedStateRead(): never {
  throw new Error("Unexpected agent state read")
}

/** State reader of an agent whose cases read no state; any read fails. */
const UNEXPECTED_STATE_READER: AgentStateReader = Object.freeze({
  listAgentMatches: handleUnexpectedStateRead,
  findAgentState: handleUnexpectedStateRead
})

/** What a case starts its turns with, and what it observes them through. */
type TurnStartHarness = Readonly<{
  /** Conversation services over the case's own database. */
  services: ConversationTestServices
  /** Registry every started generation is registered with. */
  generations: ReplyGenerationRegistry
  /** What {@link startTurn} borrows, over the services and the registry. */
  dependencies: TurnStartDependencies
  /** Title generator; rejects until a case configures it. */
  generateTitle: Mock<TurnStartDependencies["generateTitle"]>
  /**
   * Loaded check of the title task; the model is loaded with a window larger
   * than any test context.
   */
  findLoadedContextLength: Mock<
    TurnStartDependencies["findLoadedContextLength"]
  >
  /** Logger a case hands to every turn it starts. */
  logger: FastifyBaseLogger
  /** Destination of {@link TurnStartHarness.logger}. */
  log: CapturedLogDestination
}>

/** What one model request shows of the settings its turn was started with. */
type RequestedSettings = Readonly<{
  /** Model the request names. */
  model: string
  /** Sampling and reply length controls the request carries. */
  generationOptions: MessageGenerationOptions
  /** Names of the tools the request offers, in offer order. */
  toolNames: readonly string[]
}>

/**
 * Opens what a case starts turns with: real conversation services over the
 * case's own database, a real registry, and a captured log.
 *
 * @returns The harness. No attachment file is read and no tool call asks for
 * approval: either fails the case. Titles are generated in one attempt.
 * @remarks When the test finishes, the registry is disposed first, so every
 * generation has stored its final state before the database closes.
 */
function openTurnStartHarness(): TurnStartHarness {
  const { app, log } = createTestFastify()
  const services = openConversationTestServices()
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  const generateTitle = vi.fn<TurnStartDependencies["generateTitle"]>(() =>
    Promise.reject(new Error("Unexpected title request"))
  )
  const findLoadedContextLength = vi.fn<
    TurnStartDependencies["findLoadedContextLength"]
  >(() => Promise.resolve(ROOMY_CONTEXT_LENGTH))
  const attachmentFiles: TurnStartDependencies["attachmentFiles"] = {
    readAttachment: () => Promise.reject(new Error("Unexpected file read"))
  }
  const dependencies: TurnStartDependencies = {
    generations,
    turns: services.turns,
    replyParts: services.replyParts,
    titleWriter: services.turns,
    findConversation: (conversationId) =>
      services.history.getConversation(conversationId),
    attachmentFiles,
    generateTitle,
    findLoadedContextLength,
    titleGenerationMaxAttempts: 1,
    toolApprovals: new ToolApprovalService(() =>
      Promise.reject(new Error("Unexpected Just run read"))
    )
  }
  return {
    services,
    generations,
    dependencies,
    generateTitle,
    findLoadedContextLength,
    logger: app.log,
    log
  }
}

/**
 * Builds the settings a case starts its turns with.
 *
 * @param trainedForToolUse - Whether the model is trained for tool use.
 * @returns Frozen settings, with frozen tool lists, that offer the client
 * tool `read_text_file` and the backend tool `look_up_word` to a model that
 * sees no images.
 */
function buildTurnSettings(trainedForToolUse: boolean): TurnSettings {
  const lookUpWordTool: TurnBuiltInTool = Object.freeze({
    definition: LOOK_UP_WORD_TOOL,
    tool: new ScriptedBuiltInTool(),
    runsWithoutApproval: false
  })
  return Object.freeze({
    model: MODEL,
    generationOptions: GENERATION_OPTIONS,
    clientTools: Object.freeze([READ_TEXT_FILE_TOOL]),
    builtInTools: Object.freeze([lookUpWordTool]),
    mcpTools: NO_MCP_TOOLS,
    unofferedTools: NO_UNOFFERED_TOOLS,
    canSeeImages: false,
    trainedForToolUse
  })
}

/**
 * Creates the agent that answers a case's turns.
 *
 * @param openReplyStream - Model behavior.
 * @returns A leader with {@link AGENT_PROFILE}, under whose meter every
 * context fits.
 */
function createTestAgent(openReplyStream: OpenReplyStream): Agent {
  const replyModel: ReplyModel = { openReplyStream }
  return new Agent(AGENT_PROFILE, {
    replyModel,
    replyContextMeter: createRoomyReplyContextMeter(),
    stateReader: UNEXPECTED_STATE_READER
  })
}

/**
 * Creates a model whose every stream yields fixed events.
 *
 * @param events - Events yielded in order.
 * @returns A stream opener recording its requests.
 */
function createEventStream(
  events: readonly ReplyStreamEvent[]
): Mock<OpenReplyStream> {
  return vi.fn<OpenReplyStream>(async () =>
    (async function* () {
      yield* events
    })()
  )
}

/**
 * Stands in for a model whose stream never opens: the request stays pending
 * until it is cancelled.
 *
 * @param request - The round's request, with its cancellation.
 * @returns A promise that never resolves, and rejects with the abort reason
 * once the request is cancelled.
 */
function waitForRequestCancellation(
  request: ReplyStreamRequest
): Promise<never> {
  return waitForSettlementOrAbort(
    Promise.withResolvers<never>().promise,
    request.abortSignal
  )
}

/**
 * Stores a turn that starts a new conversation the test agent answers.
 *
 * @param services - Conversation services of the case.
 * @param attachments - Attachments of the turn's message; none when omitted.
 * @returns The stored turn of an untitled conversation, whose reply streams.
 */
function createStoredTurn(
  services: ConversationTestServices,
  attachments: readonly ConversationAttachmentDraft[] = []
): ConversationTurn {
  const userMessage: ConversationTurnUserMessage = {
    ...createTurnUserMessage(FIRST_MESSAGE),
    attachments
  }
  return services.turns.createConversationTurn({
    conversation: createNewConversationTarget(AGENT_PROFILE.code),
    userMessage,
    model: MODEL
  })
}

/**
 * Stores a turn that continues a stored conversation, without attachments.
 *
 * @param services - Conversation services of the case.
 * @param conversationId - UUIDv7 of the stored conversation.
 * @returns The stored turn, whose snapshot holds the conversation as it was
 * before the turn: its title and its earlier messages.
 */
function createFollowUpTurn(
  services: ConversationTestServices,
  conversationId: string
): ConversationTurn {
  const conversation: ConversationTurnTarget = {
    kind: "existing",
    id: conversationId
  }
  return services.turns.createConversationTurn({
    conversation,
    userMessage: createTurnUserMessage("And now?"),
    model: MODEL
  })
}

/**
 * Finds the status a turn's reply has as stored now.
 *
 * @param services - Conversation services of the case.
 * @param turn - The stored turn.
 * @returns The reply's status; undefined when the reply is no longer stored.
 */
function findStoredReplyStatus(
  services: ConversationTestServices,
  turn: ConversationTurn
): ConversationAssistantMessageStatus | undefined {
  const reply = services.history
    .getConversation(turn.conversation.id)
    ?.messages.find((message) => message.id === turn.assistantMessage.id)
  return reply?.role === "assistant" ? reply.status : undefined
}

/**
 * Lists what each model request shows of the settings its turn was started
 * with.
 *
 * @param openReplyStream - Stream opener of the case's model.
 * @returns The model, generation options, and offered tool names of every
 * request, in request order; empty when the model was not asked.
 */
function listRequestedSettings(
  openReplyStream: Mock<OpenReplyStream>
): readonly RequestedSettings[] {
  return openReplyStream.mock.calls.map(([request]) => ({
    model: request.model,
    generationOptions: request.generationOptions,
    toolNames: request.tools.map((tool) => tool.function.name)
  }))
}

describe("startTurn", () => {
  it("starts the turn's generation, registers it under the reply's id, and hands the agent the turn's model, options, and tools from the settings", async () => {
    const harness = openTurnStartHarness()
    const openReplyStream = createEventStream(HI_REPLY)
    const turn = createStoredTurn(harness.services)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(openReplyStream),
      settings: buildTurnSettings(true),
      startedBy: "backend",
      logger: harness.logger
    })
    const registered = harness.generations.findReplyGeneration({
      conversationId: turn.conversation.id,
      assistantMessageId: turn.assistantMessage.id
    })
    await generation.settled

    expect(registered).toBe(generation)
    expect(listRequestedSettings(openReplyStream)).toEqual([
      {
        model: MODEL,
        generationOptions: GENERATION_OPTIONS,
        toolNames: [...SETTINGS_TOOL_NAMES, ...LEADER_STATE_TOOL_NAMES]
      }
    ])
    expect(findStoredReplyStatus(harness.services, turn)).toBe("completed")
  })

  it("gives two turns started with the same settings object the same model, generation options, and tools", async () => {
    const harness = openTurnStartHarness()
    const openReplyStream = createEventStream(HI_REPLY)
    const agent = createTestAgent(openReplyStream)
    const settings = buildTurnSettings(true)
    const requested: RequestedSettings = {
      model: MODEL,
      generationOptions: GENERATION_OPTIONS,
      toolNames: [...SETTINGS_TOOL_NAMES, ...LEADER_STATE_TOOL_NAMES]
    }

    const first = startTurn(harness.dependencies, {
      turn: createStoredTurn(harness.services),
      agent,
      settings,
      startedBy: "backend",
      logger: harness.logger
    })
    await first.settled
    const second = startTurn(harness.dependencies, {
      turn: createStoredTurn(harness.services),
      agent,
      settings,
      startedBy: "backend",
      logger: harness.logger
    })
    await second.settled

    expect(listRequestedSettings(openReplyStream)).toEqual([
      requested,
      requested
    ])
  })

  it("adds the attachment reader after the settings' backend tools for a turn whose message has a text attachment and a model trained for tool use", async () => {
    const harness = openTurnStartHarness()
    const openReplyStream = createEventStream(HI_REPLY)
    const turn = createStoredTurn(harness.services, [NOTES_ATTACHMENT])

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(openReplyStream),
      settings: buildTurnSettings(true),
      startedBy: "backend",
      logger: harness.logger
    })
    await generation.settled

    expect(listRequestedSettings(openReplyStream)[0]?.toolNames).toEqual([
      ...SETTINGS_TOOL_NAMES,
      "read_attachment",
      ...LEADER_STATE_TOOL_NAMES
    ])
  })

  it("adds the attachment reader for a turn that continues a conversation whose earlier message has a text attachment", async () => {
    const harness = openTurnStartHarness()
    const openReplyStream = createEventStream(HI_REPLY)
    const earlier = createStoredTurn(harness.services, [NOTES_ATTACHMENT])
    const turn = createFollowUpTurn(harness.services, earlier.conversation.id)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(openReplyStream),
      settings: buildTurnSettings(true),
      startedBy: "backend",
      logger: harness.logger
    })
    await generation.settled

    expect(listRequestedSettings(openReplyStream)[0]?.toolNames).toEqual([
      ...SETTINGS_TOOL_NAMES,
      "read_attachment",
      ...LEADER_STATE_TOOL_NAMES
    ])
  })

  it.each([
    [
      "a model that is not trained for tool use",
      [NOTES_ATTACHMENT],
      false,
      SETTINGS_TOOL_NAMES
    ],
    [
      "a conversation whose only attachment is an image",
      [PHOTO_ATTACHMENT],
      true,
      [...SETTINGS_TOOL_NAMES, ...LEADER_STATE_TOOL_NAMES]
    ],
    [
      "a conversation without attachments",
      [],
      true,
      [...SETTINGS_TOOL_NAMES, ...LEADER_STATE_TOOL_NAMES]
    ]
  ])(
    "adds no attachment reader for %s",
    async (_label, attachments, trainedForToolUse, toolNames) => {
      const harness = openTurnStartHarness()
      const openReplyStream = createEventStream(HI_REPLY)
      const turn = createStoredTurn(harness.services, attachments)

      const generation = startTurn(harness.dependencies, {
        turn,
        agent: createTestAgent(openReplyStream),
        settings: buildTurnSettings(trainedForToolUse),
        startedBy: "backend",
        logger: harness.logger
      })
      await generation.settled

      expect(listRequestedSettings(openReplyStream)[0]?.toolNames).toEqual(
        toolNames
      )
    }
  )

  it("starts a title task for a person's turn in an untitled conversation", async () => {
    const harness = openTurnStartHarness()
    harness.generateTitle.mockResolvedValue("Trip plan")
    const turn = createStoredTurn(harness.services)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(createEventStream(HI_REPLY)),
      settings: buildTurnSettings(false),
      startedBy: "person",
      logger: harness.logger
    })
    await generation.settled

    expect(harness.generateTitle).toHaveBeenCalledOnce()
    expect(harness.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({ message: FIRST_MESSAGE, model: MODEL })
    )
    expect(
      harness.services.history.getConversation(turn.conversation.id)?.title
    ).toBe("Trip plan")
  })

  it("starts no title task for a backend-started turn, even in an untitled conversation", async () => {
    const harness = openTurnStartHarness()
    const turn = createStoredTurn(harness.services)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(createEventStream(HI_REPLY)),
      settings: buildTurnSettings(false),
      startedBy: "backend",
      logger: harness.logger
    })
    await generation.settled

    expect(findStoredReplyStatus(harness.services, turn)).toBe("completed")
    expect(harness.findLoadedContextLength).not.toHaveBeenCalled()
    expect(harness.generateTitle).not.toHaveBeenCalled()
    expect(
      harness.services.history.getConversation(turn.conversation.id)?.title
    ).toBeNull()
  })

  it("starts no title task for a titled conversation", async () => {
    const harness = openTurnStartHarness()
    const earlier = createStoredTurn(harness.services)
    const conversationId = earlier.conversation.id
    harness.services.turns.updateGeneratedConversationTitle(
      conversationId,
      "Trip plan"
    )
    const turn = createFollowUpTurn(harness.services, conversationId)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(createEventStream(HI_REPLY)),
      settings: buildTurnSettings(false),
      startedBy: "person",
      logger: harness.logger
    })
    await generation.settled

    expect(findStoredReplyStatus(harness.services, turn)).toBe("completed")
    expect(harness.findLoadedContextLength).not.toHaveBeenCalled()
    expect(harness.generateTitle).not.toHaveBeenCalled()
    expect(
      harness.services.history.getConversation(conversationId)?.title
    ).toBe("Trip plan")
  })

  it("stores the reply as failed when the agent's reply task ends without a final state", async () => {
    const harness = openTurnStartHarness()
    const storageFailure = new Error("database is locked")
    // The agent stores `completed`, then `failed` for that failure; the store
    // refuses both, so its reply task ends with the reply still streaming.
    vi.spyOn(harness.services.turns, "updateAssistantMessageState")
      .mockImplementationOnce(() => {
        throw storageFailure
      })
      .mockImplementationOnce(() => {
        throw storageFailure
      })
    const turn = createStoredTurn(harness.services)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(createEventStream(HI_REPLY)),
      settings: buildTurnSettings(false),
      startedBy: "backend",
      logger: harness.logger
    })
    await generation.settled

    expect(findStoredReplyStatus(harness.services, turn)).toBe("failed")
    expect(harness.log.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Conversation task failed"
      })
    )
  })

  it("stores the reply as interrupted when the agent's reply task was aborted and ends without a final state", async () => {
    const harness = openTurnStartHarness()
    // The agent stores `interrupted` once its request is cancelled; the store
    // refuses that write, so its reply task ends with the reply still
    // streaming.
    vi.spyOn(
      harness.services.turns,
      "updateAssistantMessageState"
    ).mockImplementationOnce(() => {
      throw new Error("database is locked")
    })
    const openReplyStream = vi.fn<OpenReplyStream>(waitForRequestCancellation)
    const turn = createStoredTurn(harness.services)

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(openReplyStream),
      settings: buildTurnSettings(false),
      startedBy: "backend",
      logger: harness.logger
    })
    await vi.waitFor(() => {
      expect(openReplyStream).toHaveBeenCalledOnce()
    })
    await generation.stopReply()

    expect(findStoredReplyStatus(harness.services, turn)).toBe("interrupted")
  })

  it("reports the reply's failure together with the storage failure when no final state can be stored", async () => {
    const harness = openTurnStartHarness()
    vi.spyOn(
      harness.services.turns,
      "updateAssistantMessageState"
    ).mockImplementation(() => {
      throw new Error("database is locked")
    })
    const turn = createStoredTurn(harness.services)
    const reportedFailure = expect.objectContaining({
      message: expect.stringContaining("Reply failure could not be finalized")
    })

    const generation = startTurn(harness.dependencies, {
      turn,
      agent: createTestAgent(createEventStream(HI_REPLY)),
      settings: buildTurnSettings(false),
      startedBy: "backend",
      logger: harness.logger
    })
    await generation.settled

    expect(findStoredReplyStatus(harness.services, turn)).toBe("streaming")
    expect(harness.log.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "Conversation task failed",
        err: reportedFailure
      })
    )
  })

  it("stores the reply as interrupted and throws when the registry is closed", async () => {
    const harness = openTurnStartHarness()
    const openReplyStream = createEventStream(HI_REPLY)
    const turn = createStoredTurn(harness.services)
    const options: StartTurnOptions = {
      turn,
      agent: createTestAgent(openReplyStream),
      settings: buildTurnSettings(false),
      startedBy: "person",
      logger: harness.logger
    }
    await harness.generations[Symbol.asyncDispose]()

    expect(() => startTurn(harness.dependencies, options)).toThrow(
      "Reply generation registry is closed"
    )
    await waitForMicrotasks()

    expect(findStoredReplyStatus(harness.services, turn)).toBe("interrupted")
    expect(openReplyStream).not.toHaveBeenCalled()
  })
})
