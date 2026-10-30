import { isDeepStrictEqual } from "node:util"
import type {
  ChatGenerationEvent,
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"
import {
  calculateImageTokens,
  toolDefinitionSchema,
  type ConversationAssistantMessage,
  type ConversationMessage,
  type ConversationSource,
  type ConversationUserMessage,
  type ReplyPart,
  type ToolDefinition
} from "@lys/share"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from "vitest"
import Agent, {
  type AgentProfile,
  type AgentTurn,
  type AssistantMessageCompletion
} from "../../../../src/modules/agent/agent"
import {
  AgentRequestLimitError,
  type AgentRequestLimits,
  type AgentRequestState
} from "../../../../src/modules/agent/agentActivity"
import {
  formatSystemPrompt,
  type GetAttachmentImageFileStatus
} from "../../../../src/modules/agent/agentContext"
import type { AgentStateReader } from "../../../../src/modules/agent/agentStateTools"
import {
  NO_UNOFFERED_TOOLS,
  TOOL_CALLS_OFF,
  type UnofferedTools
} from "../../../../src/modules/agent/unofferedTools"
import {
  ReplyContextOverflowError,
  ReplyModelNotLoadedError
} from "../../../../src/modules/agent/replyContextFit"
import type {
  ReplyContextMeasurement,
  ReplyContextMeasurementRequest,
  ReplyContextMeter
} from "../../../../src/modules/agent/replyContextMeter"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import LlmReplyContextMeter from "../../../../src/modules/chat/llmReplyContextMeter"
import type { TurnMcpTool } from "../../../../src/modules/mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../../../../src/modules/tool/builtIn/builtInTool"
import ToolCallGate, {
  type SendToolApprovalPrompt
} from "../../../../src/modules/toolApproval/toolCallGate"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import { createImageAttachment } from "../../support/attachmentFixtures"
import { parseMcpToolDefinition } from "../../support/mcpToolFixtures"
import {
  openConversationTestServices,
  saveSourceRow,
  type ConversationTestServices
} from "../../support/conversationDatabase"
import {
  createAssistantMessage,
  createNewConversationTarget,
  createTextPart,
  createToolCallPart,
  createTurnUserMessage,
  createUserMessage
} from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/microtasks"
import {
  createRoomyReplyContextMeter,
  createUnloadedReplyContextMeter,
  ROOMY_CONTEXT_LENGTH
} from "../../support/replyContextMeterFakes"
import {
  runLookUpWordWithSource,
  LOOK_UP_WORD_FORMAT,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool,
  type BuiltInToolRunScript
} from "../../support/scriptedBuiltInTool"
import {
  LEADER_STATE_TOOL_NAMES,
  READ_TEXT_FILE_FORMAT,
  READ_TEXT_FILE_TOOL
} from "../../support/toolFixtures"

/** Opens one reply stream for the agent under test. */
type OpenReplyStream = ReplyModel["openReplyStream"]

/** Wall-clock time of every stored change; the cases fake only `Date`. */
const NOW = "2026-03-04T05:06:07.890Z"

/**
 * Matches the event sent to followers after a failure that was not a
 * cancellation; its user-presentable message is any non-blank text.
 */
const CHAT_FAILURE_EVENT = Object.freeze({
  type: "error",
  message: expect.stringMatching(/\S/)
})

/** Event sent to followers when the reply ended before it completed. */
const INTERRUPTED_EVENT = Object.freeze({ type: "interrupted" })

/** Request limits of the agent under test: two replies at once, one waiting. */
const REQUEST_LIMITS: AgentRequestLimits = Object.freeze({
  slotCount: 2,
  waitingLimit: 1
})

/** Profile of the agent under test. */
const AGENT_PROFILE: AgentProfile = Object.freeze({
  code: "lys",
  role: "leader",
  systemPrompt: "You are Lys.",
  requestLimits: REQUEST_LIMITS
})

/** Unoffered tools of a request that switched off both network tools. */
const SWITCHED_OFF_SEARCH_TOOLS: UnofferedTools = Object.freeze({
  status: "tool-calls-on",
  switchedOffToolNames: Object.freeze(["web_search", "read_page"]),
  unavailableTools: Object.freeze([])
})

/** Request values every case's turn carries. */
const TURN_REQUEST = Object.freeze({
  userMessage: createUserMessage(100, "Hello"),
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4, replyCeiling: 128 }
})

/** The message of a case whose person attached a photo. */
const PHOTO_MESSAGE = createUserMessage(100, "Look", [
  createImageAttachment(1, "photo.png")
])

/** Bytes of the photo, as a case's reader returns them. */
const PHOTO_BYTES = new Uint8Array([1, 2, 3])

/** The photo message's text as the model reads it. */
const PHOTO_MESSAGE_TEXT =
  "Look\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)"

/**
 * History of an answered question followed by a failed reply; a turn sends
 * the question and its answer, not the failed reply.
 */
const ANSWERED_THEN_FAILED_HISTORY: readonly ConversationMessage[] =
  Object.freeze([
    createUserMessage(1, "Earlier question"),
    createAssistantMessage(
      2,
      [createTextPart({ sequence: 12, round: 0, content: "Earlier answer" })],
      { status: "completed", finishReason: "stop" }
    ),
    createAssistantMessage(
      3,
      [createTextPart({ sequence: 13, round: 0, content: "Failed answer" })],
      { status: "failed" }
    )
  ])

/** The stored conversation and streaming reply a case's agent writes. */
type AgentTurnStore = Readonly<{
  /** Services over the case's own test database. */
  services: ConversationTestServices
  /** Stored conversation of the turn. */
  conversationId: string
  /** Streaming reply the agent writes. */
  replyId: string
}>

/** Reply storage of one turn, bound to its stored reply. */
type ReplyStorage = Pick<
  AgentTurn,
  | "createReplyPart"
  | "updateReplyPartContent"
  | "updateReplyToolCall"
  | "updateAssistantMessageState"
>

/**
 * Replaces one storage capability of a case's turn, given the stored one.
 *
 * @param stored - The capability bound to the case's stored reply.
 * @returns The capability the turn uses.
 */
type ReplyStorageOverride<Capability> = (stored: Capability) => Capability

/**
 * The agent that answers a case's turn: one with {@link AGENT_PROFILE} over
 * the case's model and meter, or the case's own.
 */
type AgentScenario =
  | Readonly<{
      /** Model behavior. */
      openReplyStream: OpenReplyStream
      /** Context meter of the model; every context fits by default. */
      replyContextMeter?: ReplyContextMeter
    }>
  | Readonly<{
      /** Agent the case created, to read its activity while it answers. */
      agent: Agent
    }>

/** Test-controlled parts of one reply. */
type AgentReplyScenario = AgentScenario & AgentTurnScenario

/** Test-controlled parts of one turn. */
type AgentTurnScenario = Readonly<{
  /** Transcript before the turn; empty by default. */
  history?: readonly ConversationMessage[]
  /**
   * Stored turn the agent writes; a new one without sources by default. A
   * case that changes the reply while it streams opens its own.
   */
  store?: AgentTurnStore
  /** Cancellation owned by the case; a fresh signal by default. */
  abortSignal?: AbortSignal
  /** Part creation; stores every part by default. */
  createReplyPart?: ReplyStorageOverride<AgentTurn["createReplyPart"]>
  /** Fragment storage; stores every fragment by default. */
  updateReplyPartContent?: ReplyStorageOverride<
    AgentTurn["updateReplyPartContent"]
  >
  /** Final-state storage; stores every transition by default. */
  updateAssistantMessageState?: ReplyStorageOverride<
    AgentTurn["updateAssistantMessageState"]
  >
  /** Message the turn answers; `Hello` without attachments by default. */
  userMessage?: ConversationUserMessage
  /** Whether the model sees images; false by default. */
  canSeeImages?: boolean
  /** Image reader; any read fails the case by default. */
  findAttachmentImage?: AgentTurn["findAttachmentImage"]
  /** Offered client tools; none by default. */
  clientTools?: readonly ToolDefinition[]
  /** Offered backend tools; none by default. */
  builtInTools?: readonly TurnBuiltInTool[]
  /** Offered MCP tools; none by default. */
  mcpTools?: readonly TurnMcpTool[]
  /**
   * What the request names about the tools the turn does not offer; tool
   * calls on and no tool named when omitted.
   */
  unofferedTools?: UnofferedTools
  /** Client results; any client tool call fails the case by default. */
  sendClientToolCall?: AgentTurn["sendClientToolCall"]
  /**
   * Tools saved as Just run; every offered tool by default, so a case that
   * does not arrange approval runs its calls without prompts.
   */
  justRunToolNames?: readonly string[]
  /** The person's answers; any prompt fails the case by default. */
  sendToolApprovalPrompt?: SendToolApprovalPrompt
  /** Gate of each round; a gate over {@link justRunToolNames} by default. */
  createToolCallGate?: AgentTurn["createToolCallGate"]
  /** Whether the model is trained for tool use; false by default. */
  trainedForToolUse?: boolean
}>

/**
 * Opens a test database holding one new turn whose reply streams.
 *
 * @param sources - Sources the conversation stored before the turn.
 * @returns The stored turn; its database closes when the test finishes.
 */
function openAgentTurnStore(
  sources: readonly ConversationSource[] = []
): AgentTurnStore {
  const services = openConversationTestServices()
  const turn = services.turns.createConversationTurn({
    conversation: createNewConversationTarget(AGENT_PROFILE.code),
    userMessage: createTurnUserMessage(TURN_REQUEST.userMessage.content),
    model: TURN_REQUEST.model
  })
  for (const source of sources)
    saveSourceRow(services.database, turn.conversation.id, source)
  return {
    services,
    conversationId: turn.conversation.id,
    replyId: turn.assistantMessage.id
  }
}

/**
 * Builds the reply storage of a stored turn.
 *
 * @param store - Stored turn.
 * @returns The capabilities bound to the turn's reply.
 */
function buildReplyStorage(store: AgentTurnStore): ReplyStorage {
  const { replyParts, turns } = store.services
  return {
    createReplyPart: (draft) =>
      replyParts.createReplyPart(store.replyId, draft),
    updateReplyPartContent: (partId, content) =>
      replyParts.updateReplyPartContent(store.replyId, partId, content),
    updateReplyToolCall: (toolCallId, change) =>
      replyParts.updateReplyToolCall(store.replyId, toolCallId, change),
    updateAssistantMessageState: (completion) =>
      turns.updateAssistantMessageState(store.replyId, completion)
  }
}

/**
 * Gets a stored turn's reply and its conversation's sources.
 *
 * @param store - Stored turn.
 * @returns The reply as stored now and the conversation's sources.
 * @throws If the reply is no longer stored.
 */
function getStoredReply(store: AgentTurnStore): Readonly<{
  reply: ConversationAssistantMessage
  sources: readonly ConversationSource[]
}> {
  const conversation = store.services.history.getConversation(
    store.conversationId
  )
  const reply = conversation?.messages.find(
    (message) => message.id === store.replyId
  )
  if (conversation === undefined || reply?.role !== "assistant")
    throw new Error("The case's reply is not stored")
  return { reply, sources: conversation.sources }
}

/**
 * Ends a stored turn's reply as interrupted, as a newer turn or a deletion
 * ends a reply while its agent still works on it.
 *
 * @param store - Stored turn whose reply streams.
 * @throws If the reply is no longer streaming.
 */
function updateStoredReplyToInterrupted(store: AgentTurnStore): void {
  if (
    !store.services.turns.updateAssistantMessageState(store.replyId, {
      status: "interrupted"
    })
  )
    throw new Error("The case's reply was no longer streaming")
}

/**
 * Creates a model whose stream yields fixed events.
 *
 * @param events - Events yielded in order.
 * @returns A stream opener recording its requests.
 */
function createEventStream(...events: ReplyStreamEvent[]) {
  return vi.fn<OpenReplyStream>(async () =>
    (async function* () {
      yield* events
    })()
  )
}

/**
 * Fails a tool call that the current case did not arrange.
 *
 * @throws Always.
 */
function handleUnexpectedToolCall(): never {
  throw new Error("Unexpected tool call")
}

/**
 * Fails an image read that the current case did not arrange.
 *
 * @returns A promise that rejects.
 */
function handleUnexpectedImageRead(): Promise<never> {
  return Promise.reject(new Error("Unexpected attachment image read"))
}

/**
 * Fails an image file lookup that the current case did not arrange.
 *
 * @returns A promise that rejects.
 */
function handleUnexpectedImageFileLookup(): Promise<never> {
  return Promise.reject(new Error("Unexpected attachment image file lookup"))
}

/**
 * Creates the backend's own meter over a tokenizer that counts one token per
 * character, recording each measurement it resolves with.
 *
 * @returns The meter, and its measurements in request order.
 */
function createCharacterCountingReplyContextMeter() {
  const countingMeter = new LlmReplyContextMeter((_model, texts) =>
    Promise.resolve({
      contextLength: ROOMY_CONTEXT_LENGTH,
      textTokenCounts: texts.map((text) => text.length)
    })
  )
  const measurements: (ReplyContextMeasurement | undefined)[] = []
  const meter: ReplyContextMeter = {
    findReplyContextMeasurement: async (request) => {
      const measurement =
        await countingMeter.findReplyContextMeasurement(request)
      measurements.push(measurement)
      return measurement
    }
  }
  return { meter, measurements }
}

/**
 * Creates a model that answers each request with the next round's events.
 *
 * @param rounds - Events of each round, in request order.
 * @returns A stream opener recording its requests.
 */
function createRoundStreams(...rounds: (readonly ReplyStreamEvent[])[]) {
  const openReplyStream = vi.fn<OpenReplyStream>()
  for (const events of rounds)
    openReplyStream.mockImplementationOnce(async () =>
      (async function* () {
        yield* events
      })()
    )
  return openReplyStream
}

/** One step of a scripted stream: an event to yield, or an action to run. */
type ScriptedStreamStep = ReplyStreamEvent | (() => void)

/** A model whose one stream follows a script, and whether it was released. */
type ScriptedStream = Readonly<{
  /** Opens the scripted stream; records each request. */
  openReplyStream: Mock<OpenReplyStream>
  /**
   * Answers whether the reader released the stream, early or at its end.
   */
  isReleased: () => boolean
}>

/**
 * Creates a model whose one stream follows a script and reports its release.
 *
 * @param steps - Events to yield and actions to run between them.
 * @returns A stream opener recording its requests, and whether the stream
 * was released.
 */
function createScriptedStream(...steps: ScriptedStreamStep[]): ScriptedStream {
  let isReleased = false
  /**
   * Creates the scripted stream.
   *
   * @returns An iterator that yields each event of `steps`, runs each action
   * between them, and ends after the last step; once the reader releases it,
   * early or at its end, the stream counts as released.
   */
  async function* createScriptedEventStream(): AsyncGenerator<ReplyStreamEvent> {
    try {
      for (const step of steps) {
        if (typeof step === "function") step()
        else yield step
      }
    } finally {
      isReleased = true
    }
  }
  const openReplyStream = vi.fn<OpenReplyStream>(async () =>
    createScriptedEventStream()
  )
  return { openReplyStream, isReleased: () => isReleased }
}

/**
 * Answers whether an event's part or fragment was already stored when the
 * event was sent.
 *
 * @param event - Sent event.
 * @param storedParts - The reply's parts as stored when it was sent.
 * @returns For `reply-part`, whether the stored part equals the sent one;
 * for `reply-part-delta`, whether the stored reasoning or text part ends
 * with the fragment; true for an event that carries no part.
 */
function isStoredBeforeSent(
  event: ChatGenerationEvent,
  storedParts: readonly ReplyPart[]
): boolean {
  if (event.type === "reply-part")
    return isDeepStrictEqual(
      storedParts.find((part) => part.id === event.part.id),
      event.part
    )
  if (event.type !== "reply-part-delta") return true
  const storedPart = storedParts.find((part) => part.id === event.partId)
  return (
    storedPart !== undefined &&
    storedPart.kind !== "tool-call" &&
    storedPart.content.endsWith(event.content)
  )
}

/** Client tool that reaches the network, whose answers are cleaned. */
const FETCH_NOTE_TOOL: ToolDefinition = toolDefinitionSchema.parse({
  name: "fetch_note",
  description: "Fetch one note from a web service.",
  group: "network",
  access: "network",
  runner: "client",
  arguments: [{ type: "string", name: "id", description: "Note to fetch." }]
})

/** Round in which the model looks up the word `moth`. */
const LOOK_UP_MOTH_ROUND: readonly ReplyStreamEvent[] = Object.freeze([
  {
    type: "tool-calls",
    toolCalls: [{ toolName: "look_up_word", argumentText: '{"word":"moth"}' }]
  }
])

/** Round in which the model reads the file `/a`. */
const READ_A_ROUND: readonly ReplyStreamEvent[] = Object.freeze([
  {
    type: "tool-calls",
    toolCalls: [{ toolName: "read_text_file", argumentText: '{"path":"/a"}' }]
  }
])

/** Answer of a person who rejected a call with a note. */
const DECLINED_APPROVAL = Object.freeze({
  status: "rejected",
  reason: "declined",
  content: "The person declined this call. Their note: not now"
} satisfies ChatToolApprovalAnswer)

/**
 * Creates a prompt sender whose prompts the person allows.
 *
 * @returns A spy recording every prompted call.
 */
function createAllowingPromptSender() {
  return vi.fn<SendToolApprovalPrompt>(async () => ({ status: "allowed" }))
}

/** Definition of the echo tool of the MCP server `files`. */
const MCP_ECHO_DEFINITION = parseMcpToolDefinition({
  name: "mcp__files__echo",
  description: "Echoes its text.",
  group: "mcp",
  access: "unknown",
  runner: "mcp",
  server: "files",
  serverToolName: "echo",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"]
  }
})

/** Round in which the model calls the MCP echo tool with `moth`. */
const ECHO_MOTH_ROUND: readonly ReplyStreamEvent[] = Object.freeze([
  {
    type: "tool-calls",
    toolCalls: [
      { toolName: "mcp__files__echo", argumentText: '{"text":"moth"}' }
    ]
  }
])

/**
 * Builds the MCP echo tool offered for one case.
 *
 * @param sendToolCall - Runs each call; answers `echo: <text>` by default.
 * @returns The tool and a spy over its calls.
 */
function createMcpEchoTool(
  sendToolCall: TurnMcpTool["sendToolCall"] = async (callArguments) => ({
    status: "succeeded",
    content: `echo: ${JSON.stringify(callArguments)}`
  })
) {
  const call = vi.fn<TurnMcpTool["sendToolCall"]>(sendToolCall)
  const tool: TurnMcpTool = Object.freeze({
    definition: MCP_ECHO_DEFINITION,
    sendToolCall: call
  })
  return { tool, call }
}

/** Round that ends the reply without text. */
const FINISH_ROUND: readonly ReplyStreamEvent[] = Object.freeze([
  { type: "finish", finishReason: "stop" }
])

/**
 * Builds the backend look-up tool offered for one case.
 *
 * @param runScript - Work every run does; answers at once by default.
 * @returns The tool and its entry.
 */
function createLookUpWordTool(runScript?: BuiltInToolRunScript) {
  const tool = new ScriptedBuiltInTool(runScript)
  const entry: TurnBuiltInTool = {
    definition: LOOK_UP_WORD_TOOL,
    tool,
    runsWithoutApproval: false
  }
  return { tool, entry }
}

/**
 * Creates a meter that counts one token per character of each message's text
 * and offers no tools, for a model loaded with a fixed context length.
 *
 * @param contextLength - Context length the model is loaded with.
 * @returns A meter spy.
 */
function createCharacterReplyContextMeter(contextLength: number) {
  return {
    findReplyContextMeasurement: vi.fn(
      async (request: ReplyContextMeasurementRequest) => ({
        contextLength,
        messageTokenCounts: request.messages.map(
          (message) => message.content.length
        ),
        toolTokenCount: 0
      })
    )
  } satisfies ReplyContextMeter
}

/** Matches a UUIDv7 the agent or the store gave a call or part. */
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Builds the gate factory of one case.
 *
 * @param scenario - Offered tools, saved Just run choices, and prompt answers.
 * @returns A factory creating a gate over the case's choices for each round.
 */
function buildCreateToolCallGate(
  scenario: AgentReplyScenario
): AgentTurn["createToolCallGate"] {
  const justRunToolNames = scenario.justRunToolNames ?? [
    ...(scenario.clientTools ?? []).map((tool) => tool.name),
    ...(scenario.builtInTools ?? []).map((entry) => entry.definition.name),
    ...(scenario.mcpTools ?? []).map((tool) => tool.definition.name)
  ]
  const sendToolApprovalPrompt =
    scenario.sendToolApprovalPrompt ?? handleUnexpectedToolCall
  return async () =>
    new ToolCallGate(new Set(justRunToolNames), sendToolApprovalPrompt)
}

/**
 * Builds the reply storage of one case: the stored turn's, with the case's
 * replacements.
 *
 * @param scenario - Replacements of the case.
 * @param store - Stored turn of the case.
 * @returns Spies over each capability the turn uses.
 */
function buildScenarioReplyStorage(
  scenario: AgentReplyScenario,
  store: AgentTurnStore
) {
  const stored = buildReplyStorage(store)
  return {
    createReplyPart: vi.fn(
      scenario.createReplyPart?.(stored.createReplyPart) ??
        stored.createReplyPart
    ),
    updateReplyPartContent: vi.fn(
      scenario.updateReplyPartContent?.(stored.updateReplyPartContent) ??
        stored.updateReplyPartContent
    ),
    updateReplyToolCall: vi.fn(stored.updateReplyToolCall),
    updateAssistantMessageState: vi.fn(
      scenario.updateAssistantMessageState?.(
        stored.updateAssistantMessageState
      ) ?? stored.updateAssistantMessageState
    )
  }
}

/** State reader of an agent whose case reads no state; any read fails it. */
const UNEXPECTED_STATE_READER: AgentStateReader = Object.freeze({
  listAgentMatches: handleUnexpectedToolCall,
  findAgentState: handleUnexpectedToolCall
})

/**
 * Creates an agent with {@link AGENT_PROFILE}.
 *
 * @param replyModel - Model access of the case.
 * @param replyContextMeter - Context meter of the same model.
 * @param stateReader - Reader of the state tools; any read fails the case by
 * default.
 * @returns The ready agent.
 */
function createTestAgent(
  replyModel: ReplyModel,
  replyContextMeter: ReplyContextMeter,
  stateReader: AgentStateReader = UNEXPECTED_STATE_READER
): Agent {
  return new Agent(AGENT_PROFILE, {
    replyModel,
    replyContextMeter,
    stateReader
  })
}

/**
 * Finds the agent that answers a case's turn.
 *
 * @param scenario - The case's own agent, or its model and meter.
 * @returns The case's agent, or a new one with {@link AGENT_PROFILE}.
 */
function findScenarioAgent(scenario: AgentScenario): Agent {
  if ("agent" in scenario) return scenario.agent
  return createTestAgent(
    { openReplyStream: scenario.openReplyStream },
    scenario.replyContextMeter ?? createRoomyReplyContextMeter()
  )
}

/**
 * Has one agent answer one turn to settlement over a stored turn and records
 * the effects.
 *
 * @param scenario - Model, history, storage, and cancellation behavior.
 * @returns The sent events with the parts stored when each was sent, the
 * final states asked for, the storage spies, reported cancellations,
 * refusals, and failures, the reply's settlement, and the reply and sources
 * stored after it.
 */
async function getAgentReplyOutcome(scenario: AgentReplyScenario) {
  const store = scenario.store ?? openAgentTurnStore()
  const events: ChatGenerationEvent[] = []
  const storedPartsAtEvents: (readonly ReplyPart[])[] = []
  const reportedCancellations: unknown[] = []
  const reportedRefusals: unknown[] = []
  const reportedFailures: unknown[] = []
  const persistedStates: AssistantMessageCompletion[] = []
  const storage = buildScenarioReplyStorage(scenario, store)
  const settlement = await findScenarioAgent(scenario)
    .createReply({
      ...TURN_REQUEST,
      conversationId: store.conversationId,
      requestId: store.replyId,
      trainedForToolUse: scenario.trainedForToolUse ?? false,
      userMessage: scenario.userMessage ?? TURN_REQUEST.userMessage,
      canSeeImages: scenario.canSeeImages ?? false,
      findAttachmentImage:
        scenario.findAttachmentImage ?? handleUnexpectedImageRead,
      history: scenario.history ?? [],
      sources: getStoredReply(store).sources,
      clientTools: scenario.clientTools ?? [],
      builtInTools: scenario.builtInTools ?? [],
      mcpTools: scenario.mcpTools ?? [],
      unofferedTools: scenario.unofferedTools ?? NO_UNOFFERED_TOOLS,
      sendClientToolCall:
        scenario.sendClientToolCall ?? handleUnexpectedToolCall,
      createToolCallGate:
        scenario.createToolCallGate ?? buildCreateToolCallGate(scenario),
      abortSignal: scenario.abortSignal ?? new AbortController().signal,
      sendEvent: (event) => {
        events.push(event)
        storedPartsAtEvents.push(getStoredReply(store).reply.parts)
      },
      reportReplyCancellation: (failure) => {
        reportedCancellations.push(failure)
      },
      reportReplyRefusal: (failure) => {
        reportedRefusals.push(failure)
      },
      reportReplyFailure: (failure) => {
        reportedFailures.push(failure)
      },
      createReplyPart: storage.createReplyPart,
      updateReplyPartContent: storage.updateReplyPartContent,
      updateReplyToolCall: storage.updateReplyToolCall,
      updateAssistantMessageState: (completion) => {
        persistedStates.push(completion)
        return storage.updateAssistantMessageState(completion)
      }
    })
    .then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    )
  const { reply, sources } = getStoredReply(store)
  return {
    events,
    storedPartsAtEvents,
    persistedStates,
    storage,
    reportedCancellations,
    reportedRefusals,
    reportedFailures,
    settlement,
    reply,
    parts: reply.parts,
    sources
  }
}

/**
 * Builds a matcher of the event that sends a new part.
 *
 * @param part - Fields the part has.
 * @returns A matcher of the `reply-part` event.
 */
function buildReplyPartEventMatcher(part: Readonly<Record<string, unknown>>) {
  return { type: "reply-part", part: expect.objectContaining(part) }
}

/**
 * Builds a matcher of a stored reasoning or text part of this case's turn.
 *
 * @param kind - Kind of the part.
 * @param round - Round of the part.
 * @param content - Its whole text.
 * @returns A matcher of the stored part.
 */
function buildStoredFragmentPartMatcher(
  kind: "reasoning" | "text",
  round: number,
  content: string
) {
  return {
    kind,
    id: expect.stringMatching(UUID_V7_PATTERN),
    round,
    createdAt: NOW,
    updatedAt: NOW,
    content
  }
}

describe("Agent", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports the code it was created with", () => {
    const agent = createTestAgent(
      { openReplyStream: createEventStream() },
      createRoomyReplyContextMeter()
    )

    expect(agent.code).toBe("lys")
  })

  it("sends its own system prompt, the usable history, and the new message with the turn's model, options, and signal", async () => {
    const abortSignal = new AbortController().signal
    const openReplyStream = createEventStream({
      type: "finish",
      finishReason: "stop"
    })

    await getAgentReplyOutcome({
      openReplyStream,
      abortSignal,
      history: ANSWERED_THEN_FAILED_HISTORY
    })

    expect(openReplyStream).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "You are Lys." },
        { role: "user", content: "Earlier question", images: [] },
        { role: "assistant", content: "Earlier answer", toolCalls: [] },
        { role: "user", content: "Hello", images: [] }
      ],
      tools: [],
      model: TURN_REQUEST.model,
      generationOptions: TURN_REQUEST.generationOptions,
      abortSignal
    })
  })

  it("reads an image once and sends it with its message in every round of a model that sees images", async () => {
    const { entry } = createLookUpWordTool()
    const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND, FINISH_ROUND)
    const findAttachmentImage = vi.fn<AgentTurn["findAttachmentImage"]>(
      async () => PHOTO_BYTES
    )

    await getAgentReplyOutcome({
      openReplyStream,
      userMessage: PHOTO_MESSAGE,
      canSeeImages: true,
      findAttachmentImage,
      builtInTools: [entry]
    })

    expect(findAttachmentImage).toHaveBeenCalledExactlyOnceWith(
      PHOTO_MESSAGE.id,
      PHOTO_MESSAGE.attachments[0]
    )
    expect(
      openReplyStream.mock.calls.map(([request]) => request.messages[1])
    ).toEqual([
      {
        role: "user",
        content: PHOTO_MESSAGE_TEXT,
        images: [
          { mediaType: "image/png", width: 64, height: 32, data: PHOTO_BYTES }
        ]
      },
      {
        role: "user",
        content: PHOTO_MESSAGE_TEXT,
        images: [
          { mediaType: "image/png", width: 64, height: 32, data: PHOTO_BYTES }
        ]
      }
    ])
  })

  it("reads no file for a model that cannot see images and tells it so under the message", async () => {
    const openReplyStream = createEventStream({
      type: "finish",
      finishReason: "stop"
    })

    await getAgentReplyOutcome({
      openReplyStream,
      userMessage: PHOTO_MESSAGE,
      canSeeImages: false
    })

    expect(openReplyStream.mock.calls[0]?.[0].messages[1]).toEqual({
      role: "user",
      content: `${PHOTO_MESSAGE_TEXT}\n[attachment 1] photo.png is an image that this model cannot see.`,
      images: []
    })
  })

  it("stores a round's text fragments as one text part, sends the part and then each fragment, and completes with the finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "text", content: " there" },
        { type: "finish", finishReason: "stop" }
      )
    })

    expect(run.parts).toEqual([
      buildStoredFragmentPartMatcher("text", 0, "Hi there")
    ])
    expect(run.events).toEqual([
      { type: "reply-part", part: { ...run.parts[0], content: "Hi" } },
      {
        type: "reply-part-delta",
        partId: run.parts[0]?.id,
        content: " there",
        updatedAt: NOW
      },
      { type: "done", finishReason: "stop" }
    ])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.reply).toMatchObject({
      status: "completed",
      finishReason: "stop"
    })
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("stores reasoning as parts of its own, apart from the text between them", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "reasoning", content: "They say " },
        { type: "reasoning", content: "hello." },
        { type: "text", content: "Hi!" },
        { type: "reasoning", content: "Add more?" },
        { type: "text", content: " Welcome." },
        { type: "finish", finishReason: "stop" }
      )
    })

    expect(run.parts).toEqual([
      buildStoredFragmentPartMatcher("reasoning", 0, "They say hello."),
      buildStoredFragmentPartMatcher("text", 0, "Hi!"),
      buildStoredFragmentPartMatcher("reasoning", 0, "Add more?"),
      buildStoredFragmentPartMatcher("text", 0, " Welcome.")
    ])
    expect(run.events.map((event) => event.type)).toEqual([
      "reply-part",
      "reply-part-delta",
      "reply-part",
      "reply-part",
      "reply-part",
      "done"
    ])
  })

  it("stores every part and fragment before sending it", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "reasoning", content: "Think" },
        { type: "reasoning", content: "ing" },
        { type: "text", content: "Hi" },
        { type: "text", content: " there" },
        { type: "finish", finishReason: "stop" }
      )
    })

    expect(
      run.events.filter(
        (event, index) =>
          !isStoredBeforeSent(event, run.storedPartsAtEvents[index] ?? [])
      )
    ).toEqual([])
    expect(run.events).toHaveLength(5)
  })

  it("completes with a length finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Cut" },
        { type: "finish", finishReason: "length" }
      )
    })

    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Cut" }),
      { type: "done", finishReason: "length" }
    ])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "length" }
    ])
  })

  it("interrupts without sending a fragment the store refused because a newer turn finalized the reply, and releases the stream", async () => {
    const store = openAgentTurnStore()
    const stream = createScriptedStream(
      { type: "text", content: "Hi" },
      () => {
        store.services.turns.updateAssistantMessageState(store.replyId, {
          status: "interrupted"
        })
      },
      { type: "text", content: " refused" },
      { type: "text", content: " after" },
      { type: "finish", finishReason: "stop" }
    )
    const run = await getAgentReplyOutcome({
      store,
      openReplyStream: stream.openReplyStream
    })

    expect(run.storage.updateReplyPartContent.mock.calls).toEqual([
      [run.parts[0]?.id, " refused"]
    ])
    expect(run.parts).toEqual([buildStoredFragmentPartMatcher("text", 0, "Hi")])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Hi" }),
      INTERRUPTED_EVENT
    ])
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(stream.isReleased()).toBe(true)
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("reports an interruption when a newer turn finalized the reply before it completed", async () => {
    const store = openAgentTurnStore()
    const run = await getAgentReplyOutcome({
      store,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Hi" }
          store.services.turns.updateAssistantMessageState(store.replyId, {
            status: "interrupted"
          })
          yield { type: "finish", finishReason: "stop" }
        })()
      )
    })

    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Hi" }),
      INTERRUPTED_EVENT
    ])
    expect(run.reply.status).toBe("interrupted")
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("interrupts without contacting the model when already cancelled", async () => {
    const openReplyStream = createEventStream()

    const run = await getAgentReplyOutcome({
      openReplyStream,
      abortSignal: AbortSignal.abort()
    })

    expect(openReplyStream).not.toHaveBeenCalled()
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.parts).toEqual([])
  })

  it("stops reading the stream once cancelled, keeps the stored text, and releases the stream", async () => {
    const cancellation = new AbortController()
    const stream = createScriptedStream(
      { type: "text", content: "Partial" },
      () => {
        cancellation.abort()
      },
      { type: "text", content: "ignored" },
      { type: "finish", finishReason: "stop" }
    )
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: stream.openReplyStream
    })

    expect(run.parts).toEqual([
      buildStoredFragmentPartMatcher("text", 0, "Partial")
    ])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Partial" }),
      INTERRUPTED_EVENT
    ])
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.reply.status).toBe("interrupted")
    expect(stream.isReleased()).toBe(true)
  })

  it("interrupts when the stream ends after cancellation", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Partial" }
          cancellation.abort()
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Partial" }),
      INTERRUPTED_EVENT
    ])
  })

  it("interrupts and reports a cancellation when the model reports cancellation before the agent observes its abort", async () => {
    const cancellation = new ChatCompletionCancelledError(new Error("aborted"))
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw cancellation
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.reportedCancellations).toEqual([cancellation])
    expect(run.reportedFailures).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("interrupts when the model request fails after the turn was stopped", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        cancellation.abort()
        throw new Error("socket hang up")
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.reportedCancellations).toEqual([
      expect.objectContaining({ message: "socket hang up" })
    ])
    expect(run.reportedFailures).toEqual([])
  })

  it("interrupts when the stream fails after its own abort", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Partial" }
          cancellation.abort()
          throw new Error("socket hang up")
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Partial" }),
      INTERRUPTED_EVENT
    ])
    expect(run.reportedCancellations).toEqual([
      expect.objectContaining({ message: "socket hang up" })
    ])
    expect(run.reportedFailures).toEqual([])
  })

  it("fails with an error event and reports the failure when the model request is rejected", async () => {
    const rejection = new Error("model not loaded")
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw rejection
      })
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.reportedFailures).toEqual([rejection])
    expect(run.reportedCancellations).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails after the sent text when the stream fails, keeping the stored parts", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "reasoning", content: "Hmm" }
          yield { type: "text", content: "Partial" }
          throw new Error("Unsupported chat finish reason")
        })()
      )
    })

    expect(run.parts).toEqual([
      buildStoredFragmentPartMatcher("reasoning", 0, "Hmm"),
      buildStoredFragmentPartMatcher("text", 0, "Partial")
    ])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "reasoning", content: "Hmm" }),
      buildReplyPartEventMatcher({ kind: "text", content: "Partial" }),
      CHAT_FAILURE_EVENT
    ])
  })

  it("fails after the sent text when the stream ends without a finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "Partial" })
    })

    expect(run.parts).toEqual([
      buildStoredFragmentPartMatcher("text", 0, "Partial")
    ])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Partial" }),
      CHAT_FAILURE_EVENT
    ])
    expect(run.reportedFailures).toEqual([
      new Error("Model stream ended without a finish reason")
    ])
  })

  it("fails, as before tools existed, when the model calls a tool although none was offered", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({
        type: "tool-calls",
        toolCalls: [{ toolName: "read_text_file", argumentText: "{}" }]
      })
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.reportedFailures).toEqual([
      new Error("The model called a tool although none was offered")
    ])
    expect(run.parts).toEqual([])
  })

  it("fails without sending a part that cannot be stored", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "Hi" }),
      createReplyPart: () => () => {
        throw new Error("Database is closed")
      }
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
  })

  it("fails without sending a fragment that cannot be stored", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "text", content: " there" }
      ),
      updateReplyPartContent: () => () => {
        throw new Error("Database is closed")
      }
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Hi" }),
      CHAT_FAILURE_EVENT
    ])
    expect(run.parts).toEqual([buildStoredFragmentPartMatcher("text", 0, "Hi")])
  })

  it("fails after the sent text when the completed state cannot be stored", async () => {
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "finish", finishReason: "stop" }
      ),
      updateAssistantMessageState: (stored) =>
        vi.fn(stored).mockImplementationOnce(() => {
          throw persistenceFailure
        })
    })

    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" },
      { status: "failed" }
    ])
    expect(run.events).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Hi" }),
      CHAT_FAILURE_EVENT
    ])
    expect(run.reportedFailures).toEqual([persistenceFailure])
    expect(run.reply.status).toBe("failed")
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails when the interrupted state cannot be stored", async () => {
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "refused" }),
      createReplyPart: () => () => undefined,
      updateAssistantMessageState: (stored) =>
        vi.fn(stored).mockImplementationOnce(() => {
          throw persistenceFailure
        })
    })

    expect(run.persistedStates).toEqual([
      { status: "interrupted" },
      { status: "failed" }
    ])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("rejects with both failures and sends no event when the failed state cannot be stored", async () => {
    const streamFailure = new Error("model not loaded")
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw streamFailure
      }),
      updateAssistantMessageState: () => () => {
        throw persistenceFailure
      }
    })

    expect(run.settlement).toEqual({
      status: "rejected",
      error: expect.any(AggregateError)
    })
    expect(run.settlement).toMatchObject({
      error: { errors: [streamFailure, persistenceFailure] }
    })
    expect(run.events).toEqual([])
  })

  it("answers overlapping turns independently, listing only the one still in progress", async () => {
    const firstReplyGate = Promise.withResolvers<void>()
    const agent = createTestAgent(
      {
        openReplyStream: async (request) => {
          const question = request.messages.at(-1)?.content ?? ""
          return (async function* (): AsyncGenerator<ReplyStreamEvent> {
            if (question === "First") await firstReplyGate.promise
            yield { type: "text", content: `Re: ${question}` }
            yield { type: "finish", finishReason: "stop" }
          })()
        }
      },
      createRoomyReplyContextMeter()
    )
    const firstStore = openAgentTurnStore()
    const secondStore = openAgentTurnStore()
    const firstEvents: ChatGenerationEvent[] = []
    const secondEvents: ChatGenerationEvent[] = []
    /**
     * Builds a turn over its own stored reply that records its events.
     *
     * @param userMessageContent - Question the turn answers.
     * @param store - Stored turn whose reply it writes.
     * @param events - Receives the turn's events in order.
     * @returns The turn.
     */
    const createTurn = (
      userMessageContent: string,
      store: AgentTurnStore,
      events: ChatGenerationEvent[]
    ): AgentTurn => ({
      ...TURN_REQUEST,
      ...buildReplyStorage(store),
      conversationId: store.conversationId,
      requestId: store.replyId,
      trainedForToolUse: false,
      history: [],
      sources: [],
      clientTools: [],
      builtInTools: [],
      mcpTools: [],
      unofferedTools: NO_UNOFFERED_TOOLS,
      sendClientToolCall: handleUnexpectedToolCall,
      createToolCallGate: handleUnexpectedToolCall,
      userMessage: createUserMessage(101, userMessageContent),
      canSeeImages: false,
      findAttachmentImage: handleUnexpectedImageRead,
      abortSignal: new AbortController().signal,
      sendEvent: (event) => {
        events.push(event)
      },
      reportReplyCancellation: () => undefined,
      reportReplyRefusal: () => undefined,
      reportReplyFailure: () => undefined
    })

    const firstReply = agent.createReply(
      createTurn("First", firstStore, firstEvents)
    )
    await agent.createReply(createTurn("Second", secondStore, secondEvents))
    expect(firstEvents).toEqual([])
    expect(agent.listRequests()).toEqual([
      expect.objectContaining({ requestId: firstStore.replyId })
    ])
    firstReplyGate.resolve()
    await firstReply

    expect(firstEvents).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Re: First" }),
      { type: "done", finishReason: "stop" }
    ])
    expect(secondEvents).toEqual([
      buildReplyPartEventMatcher({ kind: "text", content: "Re: Second" }),
      { type: "done", finishReason: "stop" }
    ])
    expect(getStoredReply(firstStore).reply.parts).toEqual([
      buildStoredFragmentPartMatcher("text", 0, "Re: First")
    ])
    expect(getStoredReply(secondStore).reply.parts).toEqual([
      buildStoredFragmentPartMatcher("text", 0, "Re: Second")
    ])
  })

  describe("context window", () => {
    it("measures each round's context, tools, and model before the round is sent", async () => {
      const order: string[] = []
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockImplementation(
        async (request) => {
          order.push("measure")
          return {
            contextLength: 1_000_000,
            messageTokenCounts: request.messages.map(() => 1),
            toolTokenCount: 0
          }
        }
      )
      const roundStreams = createRoundStreams(READ_A_ROUND, FINISH_ROUND)
      const openReplyStream = vi.fn<OpenReplyStream>(async (request) => {
        order.push("send")
        return await roundStreams(request)
      })

      await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "text of /a"
        })
      })

      expect(order).toEqual(["measure", "send", "measure", "send"])
      const measuredRequests =
        replyContextMeter.findReplyContextMeasurement.mock.calls.map(
          ([request]) => request
        )
      const sentRequests = openReplyStream.mock.calls.map(([request]) => ({
        messages: request.messages,
        tools: request.tools,
        model: request.model
      }))
      expect(measuredRequests).toEqual(sentRequests)
    })

    it("sends a round whose context and reply ceiling take exactly the whole window", async () => {
      const openReplyStream = createEventStream({
        type: "finish",
        finishReason: "stop"
      })
      const replyCeiling = TURN_REQUEST.generationOptions.replyCeiling
      const contextLength =
        replyCeiling + "You are Lys.".length + "Hello".length

      const run = await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter: createCharacterReplyContextMeter(contextLength)
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.persistedStates).toEqual([
        { status: "completed", finishReason: "stop" }
      ])
    })

    it("fails without contacting the model, and says why, when the context and the reply ceiling exceed the window", async () => {
      const openReplyStream = createEventStream({
        type: "finish",
        finishReason: "stop"
      })
      const replyCeiling = TURN_REQUEST.generationOptions.replyCeiling
      const requiredTokens =
        replyCeiling + "You are Lys.".length + "Hello".length
      const contextLength = requiredTokens - 1

      const run = await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter: createCharacterReplyContextMeter(contextLength)
      })

      expect(openReplyStream).not.toHaveBeenCalled()
      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events).toEqual([
        {
          type: "error",
          message: `The conversation no longer fits the model's context window: the next request to the model needs ${requiredTokens} tokens, including the room kept for the reply, and the model is loaded with ${contextLength}. Start a new conversation, or load the model with a longer context in Settings → Model.`
        }
      ])
      expect(run.reportedRefusals).toEqual([
        expect.any(ReplyContextOverflowError)
      ])
      expect(run.reportedFailures).toEqual([])
      expect(run.reportedRefusals[0]).toMatchObject({
        requiredTokens,
        contextLength
      })
      expect(run.settlement).toEqual({ status: "resolved" })
    })

    it("does not send the round after a tool result that overflows the window, keeping the earlier round's parts", async () => {
      const openReplyStream = createRoundStreams(
        [{ type: "text", content: "Let me read it." }, ...READ_A_ROUND],
        [
          { type: "text", content: "The first message's answer again." },
          { type: "finish", finishReason: "stop" }
        ]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "x".repeat(20_000)
        }),
        replyContextMeter: createCharacterReplyContextMeter(8192)
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([
        buildStoredFragmentPartMatcher("text", 0, "Let me read it."),
        expect.objectContaining({
          kind: "tool-call",
          round: 0,
          status: "succeeded"
        })
      ])
      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events.at(-1)).toEqual({
        type: "error",
        message: expect.stringContaining(
          "the model is loaded with 8,192. Start a new conversation"
        )
      })
    })

    it("fails without contacting the model, and says how to load it, when the model is not loaded", async () => {
      const openReplyStream = createEventStream({
        type: "finish",
        finishReason: "stop"
      })

      const run = await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter: createUnloadedReplyContextMeter()
      })

      expect(openReplyStream).not.toHaveBeenCalled()
      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events).toEqual([
        {
          type: "error",
          message:
            "The model is not loaded, so Lys cannot check that the conversation fits it. Load the model in Settings → Model, then try again."
        }
      ])
      expect(run.reportedRefusals).toEqual([
        expect.any(ReplyModelNotLoadedError)
      ])
      expect(run.reportedFailures).toEqual([])
    })

    it("interrupts without waiting for a pending measurement, and never sends the round, when stopped while the context is measured", async () => {
      const cancellation = new AbortController()
      const measurement = Promise.withResolvers<
        ReplyContextMeasurement | undefined
      >()
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockImplementation(() => {
        // Stop arrives after the agent starts waiting for the measurement.
        queueMicrotask(() => {
          cancellation.abort()
        })
        return measurement.promise
      })
      const openReplyStream = createEventStream({
        type: "finish",
        finishReason: "stop"
      })

      const run = await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter,
        abortSignal: cancellation.signal
      })
      measurement.resolve({
        contextLength: 1_000_000,
        messageTokenCounts: [1, 1],
        toolTokenCount: 0
      })
      await measurement.promise

      expect(run.settlement).toEqual({ status: "resolved" })
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.events).toEqual([INTERRUPTED_EVENT])
      expect(run.reportedCancellations).toEqual([cancellation.signal.reason])
      expect(run.reportedFailures).toEqual([])
      expect(openReplyStream).not.toHaveBeenCalled()
    })

    it("fails with the general sentence and reports the failure when the context cannot be measured", async () => {
      const openReplyStream = createEventStream({
        type: "finish",
        finishReason: "stop"
      })
      const measurementFailure = new Error("The LLM runtime is unavailable.")
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockRejectedValue(
        measurementFailure
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        replyContextMeter
      })

      expect(openReplyStream).not.toHaveBeenCalled()
      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events).toEqual([
        { type: "error", message: "Chat completion failed. Please try again." }
      ])
      expect(run.reportedFailures).toEqual([measurementFailure])
    })
  })

  describe("findContextMeasurement", () => {
    it("measures its system prompt, the usable history, the offered tools, and an empty new message as a turn sends them", async () => {
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
        contextLength: 8192,
        messageTokenCounts: [2260, 400, 600, 9],
        toolTokenCount: 410
      })
      const agent = createTestAgent(
        { openReplyStream: createEventStream() },
        replyContextMeter
      )

      const measurement = await agent.findContextMeasurement({
        trainedForToolUse: false,
        history: ANSWERED_THEN_FAILED_HISTORY,
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [READ_TEXT_FILE_TOOL, LOOK_UP_WORD_TOOL],
        unofferedTools: NO_UNOFFERED_TOOLS
      })

      expect(measurement).toEqual({
        contextLength: 8192,
        systemPromptTokens: 2260,
        toolTokens: 410,
        historyTokens: 1000,
        historyMessageCount: 2,
        messageMarkupTokens: 9
      })
      expect(
        replyContextMeter.findReplyContextMeasurement
      ).toHaveBeenCalledExactlyOnceWith({
        messages: [
          { role: "system", content: "You are Lys." },
          { role: "user", content: "Earlier question", images: [] },
          { role: "assistant", content: "Earlier answer", toolCalls: [] },
          { role: "user", content: "", images: [] }
        ],
        tools: [READ_TEXT_FILE_FORMAT, LOOK_UP_WORD_FORMAT],
        model: TURN_REQUEST.model
      })
    })

    it("measures the note that names the switched-off tools as part of the system prompt", async () => {
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
        contextLength: 8192,
        messageTokenCounts: [2310, 9],
        toolTokenCount: 0
      })
      const agent = createTestAgent(
        { openReplyStream: createEventStream() },
        replyContextMeter
      )

      const measurement = await agent.findContextMeasurement({
        trainedForToolUse: false,
        history: [],
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [],
        unofferedTools: {
          status: "tool-calls-on",
          switchedOffToolNames: ["web_search"],
          unavailableTools: []
        }
      })

      expect(measurement).toMatchObject({ systemPromptTokens: 2310 })
      expect(
        replyContextMeter.findReplyContextMeasurement
      ).toHaveBeenCalledExactlyOnceWith({
        messages: [
          {
            role: "system",
            content: formatSystemPrompt(AGENT_PROFILE.systemPrompt, {
              status: "tool-calls-on",
              switchedOffToolNames: ["web_search"],
              unavailableTools: []
            })
          },
          { role: "user", content: "", images: [] }
        ],
        tools: [],
        model: TURN_REQUEST.model
      })
    })

    it("counts a stored reply once, with every token its rounds and tool results send", async () => {
      const replyContextMeter = createRoomyReplyContextMeter()
      replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
        contextLength: 8192,
        messageTokenCounts: [2260, 10, 20, 30, 40, 9],
        toolTokenCount: 0
      })
      const agent = createTestAgent(
        { openReplyStream: createEventStream() },
        replyContextMeter
      )
      const readCall = createToolCallPart(
        {
          sequence: 13,
          round: 0,
          toolName: "read_text_file",
          argumentText: '{"path":"/a"}'
        },
        { status: "succeeded", result: "Buy milk", sourceNumbers: [] }
      )

      const measurement = await agent.findContextMeasurement({
        trainedForToolUse: false,
        history: [
          createUserMessage(1, "What does /a say?"),
          createAssistantMessage(
            2,
            [
              createTextPart({
                sequence: 12,
                round: 0,
                content: "Let me look."
              }),
              readCall,
              createTextPart({ sequence: 14, round: 1, content: "Buy milk." })
            ],
            { status: "completed", finishReason: "stop" }
          )
        ],
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [],
        unofferedTools: NO_UNOFFERED_TOOLS
      })

      expect(measurement).toMatchObject({
        historyTokens: 100,
        historyMessageCount: 2,
        messageMarkupTokens: 9
      })
      expect(
        replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0]
          .messages
      ).toHaveLength(6)
    })

    it("resolves to undefined when the model is not loaded", async () => {
      const agent = createTestAgent(
        { openReplyStream: createEventStream() },
        createUnloadedReplyContextMeter()
      )

      await expect(
        agent.findContextMeasurement({
          trainedForToolUse: false,
          history: [],
          model: TURN_REQUEST.model,
          canSeeImages: false,
          getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
          tools: [],
          unofferedTools: NO_UNOFFERED_TOOLS
        })
      ).resolves.toBeUndefined()
    })

    describe("history images of a model that sees images", () => {
      const storedPhoto = createImageAttachment(1, "stored.png", {
        width: 640,
        height: 480
      })
      const missingPhoto = createImageAttachment(2, "missing.png")
      const photoHistory: readonly ConversationMessage[] = Object.freeze([
        createUserMessage(1, "Look", [storedPhoto, missingPhoto]),
        createAssistantMessage(
          2,
          [createTextPart({ sequence: 12, round: 0, content: "A moth." })],
          { status: "completed", finishReason: "stop" }
        )
      ])

      /**
       * Answers that the stored photo's file is on this machine and the
       * missing photo's is not.
       */
      const getPhotoFileStatus: GetAttachmentImageFileStatus = (
        _messageId,
        attachment
      ) => Promise.resolve(attachment.number === 1 ? "stored" : "missing")

      it("looks up each image's file without reading it, and sends a stored image as its sides and a missing one as its placeholder", async () => {
        const replyContextMeter = createRoomyReplyContextMeter()
        const getAttachmentImageFileStatus =
          vi.fn<GetAttachmentImageFileStatus>(getPhotoFileStatus)
        const agent = createTestAgent(
          { openReplyStream: createEventStream() },
          replyContextMeter
        )

        await agent.findContextMeasurement({
          trainedForToolUse: false,
          history: photoHistory,
          model: TURN_REQUEST.model,
          canSeeImages: true,
          getAttachmentImageFileStatus,
          tools: [],
          unofferedTools: NO_UNOFFERED_TOOLS
        })

        expect(getAttachmentImageFileStatus.mock.calls).toEqual([
          [photoHistory[0]?.id, storedPhoto],
          [photoHistory[0]?.id, missingPhoto]
        ])
        expect(
          replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0]
            .messages[1]
        ).toEqual({
          role: "user",
          content: expect.stringContaining(
            "[attachment 2] missing.png is an image whose file is missing from this machine"
          ),
          images: [{ width: 640, height: 480 }]
        })
      })

      it("counts the history as a turn's first round sends it, with the stored image's tokens", async () => {
        const measured = createCharacterCountingReplyContextMeter()
        const turn = createCharacterCountingReplyContextMeter()
        const agent = createTestAgent(
          { openReplyStream: createEventStream() },
          measured.meter
        )

        const measurement = await agent.findContextMeasurement({
          trainedForToolUse: false,
          history: photoHistory,
          model: TURN_REQUEST.model,
          canSeeImages: true,
          getAttachmentImageFileStatus: getPhotoFileStatus,
          tools: [],
          unofferedTools: NO_UNOFFERED_TOOLS
        })
        await getAgentReplyOutcome({
          openReplyStream: createEventStream({
            type: "finish",
            finishReason: "stop"
          }),
          history: photoHistory,
          canSeeImages: true,
          findAttachmentImage: (_messageId, attachment) =>
            Promise.resolve(attachment.number === 1 ? PHOTO_BYTES : undefined),
          replyContextMeter: turn.meter
        })

        const [systemPromptTokens, ...laterTokenCounts] =
          turn.measurements[0]?.messageTokenCounts ?? []
        expect(measurement).toMatchObject({
          systemPromptTokens,
          historyTokens: laterTokenCounts
            .slice(0, -1)
            .reduce((total, messageTokens) => total + messageTokens, 0)
        })
        expect(measurement?.historyTokens).toBeGreaterThan(
          calculateImageTokens(640, 480)
        )
      })
    })
  })

  describe("tool calls", () => {
    it("offers the turn's tools, sends each checked call in the model's order, and asks the model again with the results", async () => {
      const sentCalls: ChatToolCall[] = []
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' },
              { toolName: "read_text_file", argumentText: '{"path":"/b"}' }
            ]
          }
        ],
        [
          { type: "text", content: "Both read." },
          { type: "finish", finishReason: "stop" }
        ]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async (toolCall) => {
          sentCalls.push(toolCall)
          return {
            status: "succeeded",
            content: `text of ${String(toolCall.arguments.path)}`
          }
        }
      })

      expect(sentCalls).toEqual([
        {
          id: expect.stringMatching(UUID_V7_PATTERN),
          toolName: "read_text_file",
          arguments: { path: "/a" }
        },
        {
          id: expect.stringMatching(UUID_V7_PATTERN),
          toolName: "read_text_file",
          arguments: { path: "/b" }
        }
      ])
      const [firstCall, secondCall] = sentCalls
      expect(openReplyStream.mock.calls[0]?.[0].tools).toEqual([
        READ_TEXT_FILE_FORMAT
      ])
      expect(openReplyStream.mock.calls[1]?.[0].messages.slice(-3)).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: firstCall?.id,
              toolName: "read_text_file",
              argumentText: '{"path":"/a"}'
            },
            {
              id: secondCall?.id,
              toolName: "read_text_file",
              argumentText: '{"path":"/b"}'
            }
          ]
        },
        { role: "tool", toolCallId: firstCall?.id, content: "text of /a" },
        { role: "tool", toolCallId: secondCall?.id, content: "text of /b" }
      ])
      expect(run.parts.at(-1)).toMatchObject({ content: "Both read." })
      expect(run.events.at(-1)).toEqual({ type: "done", finishReason: "stop" })
    })

    it("stores each call under the identifier it sends, as running, then with its result", async () => {
      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(READ_A_ROUND, FINISH_ROUND),
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "Buy milk"
        })
      })

      const call = {
        kind: "tool-call",
        id: expect.stringMatching(UUID_V7_PATTERN),
        round: 0,
        toolName: "read_text_file",
        argumentText: '{"path":"/a"}',
        createdAt: NOW,
        updatedAt: NOW
      }
      const succeeded = {
        ...call,
        status: "succeeded",
        result: "Buy milk",
        sourceNumbers: []
      }
      expect(run.parts).toEqual([succeeded])
      expect(run.events).toEqual([
        { type: "reply-part", part: { ...call, status: "running" } },
        { type: "reply-part", part: succeeded },
        { type: "done", finishReason: "stop" }
      ])
      expect(run.storage.updateReplyToolCall).toHaveBeenCalledWith(
        run.parts[0]?.id,
        { status: "succeeded", result: "Buy milk", sources: [] }
      )
    })

    it("keeps the model's order when the client answers the second call first", async () => {
      const answers = new Map<
        string,
        PromiseWithResolvers<ChatToolResult | undefined>
      >()
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' },
              { toolName: "read_text_file", argumentText: '{"path":"/b"}' }
            ]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>(
        (toolCall) => {
          const answer = Promise.withResolvers<ChatToolResult | undefined>()
          answers.set(String(toolCall.arguments.path), answer)
          return answer.promise
        }
      )

      const outcome = getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall
      })
      await vi.waitFor(() => {
        expect(answers.size).toBe(2)
      })
      answers.get("/b")?.resolve({ status: "succeeded", content: "B" })
      answers.get("/a")?.resolve({ status: "succeeded", content: "A" })
      const run = await outcome

      const contents = openReplyStream.mock.calls[1]?.[0].messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
      expect(contents).toEqual(["A", "B"])
      expect(run.parts).toEqual([
        expect.objectContaining({ argumentText: '{"path":"/a"}', result: "A" }),
        expect.objectContaining({ argumentText: '{"path":"/b"}', result: "B" })
      ])
    })

    it("stores an unknown tool and invalid arguments as failed calls and answers them without sending them", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "delete_everything", argumentText: "{}" },
              { toolName: "read_text_file", argumentText: '{"path":1}' }
            ]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall
      })

      expect(sendClientToolCall).not.toHaveBeenCalled()
      const toolMessages = openReplyStream.mock.calls[1]?.[0].messages.filter(
        (message) => message.role === "tool"
      )
      expect(toolMessages).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("delete_everything")
        }),
        expect.objectContaining({
          content: expect.stringContaining("read_text_file")
        })
      ])
      expect(run.parts).toEqual([
        expect.objectContaining({
          toolName: "delete_everything",
          status: "failed",
          result: toolMessages?.[0]?.content
        }),
        expect.objectContaining({
          toolName: "read_text_file",
          status: "failed",
          result: toolMessages?.[1]?.content
        })
      ])
      expect(run.events.slice(0, 2)).toEqual([
        buildReplyPartEventMatcher({
          toolName: "delete_everything",
          status: "failed"
        }),
        buildReplyPartEventMatcher({
          toolName: "read_text_file",
          status: "failed"
        })
      ])
    })

    it("answers a call of a switched-off tool as off without asking or running it, and names the switched-off tools in every round's instructions", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [{ toolName: "web_search", argumentText: "{}" }]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()
      const createToolCallGate = vi.fn<AgentTurn["createToolCallGate"]>()

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        unofferedTools: SWITCHED_OFF_SEARCH_TOOLS,
        sendClientToolCall,
        createToolCallGate
      })

      const offMessage =
        '"web_search" is turned off in Settings → Tools, so it did not run. Say that it is turned off instead of guessing what it would return.'
      expect(sendClientToolCall).not.toHaveBeenCalled()
      expect(createToolCallGate).not.toHaveBeenCalled()
      expect(run.parts).toEqual([
        expect.objectContaining({
          toolName: "web_search",
          status: "failed",
          result: offMessage
        })
      ])
      const roundMessages = openReplyStream.mock.calls.map(
        ([request]) => request.messages
      )
      expect(roundMessages[1]).toContainEqual(
        expect.objectContaining({ role: "tool", content: offMessage })
      )
      for (const messages of roundMessages) {
        expect(messages[0]).toEqual({
          role: "system",
          content: formatSystemPrompt(
            AGENT_PROFILE.systemPrompt,
            SWITCHED_OFF_SEARCH_TOOLS
          )
        })
      }
    })

    it("answers a call of a switched-on tool that cannot run now with why, without asking or running it, and says why in every round's instructions", async () => {
      const unofferedTools: UnofferedTools = {
        status: "tool-calls-on",
        switchedOffToolNames: [],
        unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
      }
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [{ toolName: "web_search", argumentText: "{}" }]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()
      const createToolCallGate = vi.fn<AgentTurn["createToolCallGate"]>()

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        unofferedTools,
        sendClientToolCall,
        createToolCallGate
      })

      const unavailableMessage =
        '"web_search" did not run: it is turned on but cannot run now, because no Tavily API key is saved (one can be added in Settings → Secrets). Say why it cannot run instead of guessing what it would return.'
      expect(sendClientToolCall).not.toHaveBeenCalled()
      expect(createToolCallGate).not.toHaveBeenCalled()
      expect(run.parts).toEqual([
        expect.objectContaining({
          toolName: "web_search",
          status: "failed",
          result: unavailableMessage
        })
      ])
      const roundMessages = openReplyStream.mock.calls.map(
        ([request]) => request.messages
      )
      for (const messages of roundMessages) {
        expect(messages[0]).toEqual({
          role: "system",
          content: formatSystemPrompt(
            AGENT_PROFILE.systemPrompt,
            unofferedTools
          )
        })
      }
    })

    it("answers a call while tool calls are off as off, even with no tool offered, and says tool calls are off in every round's instructions", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [{ toolName: "get_current_time", argumentText: "{}" }]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        unofferedTools: TOOL_CALLS_OFF
      })

      expect(run.persistedStates).toEqual([
        { status: "completed", finishReason: "stop" }
      ])
      expect(run.parts).toEqual([
        expect.objectContaining({
          toolName: "get_current_time",
          status: "failed",
          result:
            '"get_current_time" did not run: tool calls are turned off in Settings → Tools. Say that tool calls are turned off instead of guessing what it would return.'
        })
      ])
      for (const [request] of openReplyStream.mock.calls) {
        expect(request.messages[0]).toEqual({
          role: "system",
          content: formatSystemPrompt(
            AGENT_PROFILE.systemPrompt,
            TOOL_CALLS_OFF
          )
        })
      }
    })

    it("answers a call of a switched-off tool when no tool is offered, and an unknown name as one no tool has", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "web_search", argumentText: "{}" },
              { toolName: "fetch_url", argumentText: "{}" }
            ]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        unofferedTools: SWITCHED_OFF_SEARCH_TOOLS
      })

      expect(run.persistedStates).toEqual([
        { status: "completed", finishReason: "stop" }
      ])
      expect(run.parts).toEqual([
        expect.objectContaining({
          toolName: "web_search",
          status: "failed",
          result:
            '"web_search" is turned off in Settings → Tools, so it did not run. Say that it is turned off instead of guessing what it would return.'
        }),
        expect.objectContaining({
          toolName: "fetch_url",
          status: "failed",
          result: 'No tool is named "fetch_url", and you can call no tool now.'
        })
      ])
    })

    it("stores each round's parts under the round's index and gives the model each round's own text with its calls", async () => {
      const openReplyStream = createRoundStreams(
        [
          { type: "text", content: "Let me look." },
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
            ]
          }
        ],
        [
          { type: "reasoning", content: "It says milk." },
          { type: "text", content: "Found it." },
          { type: "text", content: " Buy milk." },
          { type: "finish", finishReason: "stop" }
        ]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "Buy milk"
        })
      })

      expect(run.parts).toEqual([
        buildStoredFragmentPartMatcher("text", 0, "Let me look."),
        expect.objectContaining({
          kind: "tool-call",
          round: 0,
          status: "succeeded"
        }),
        buildStoredFragmentPartMatcher("reasoning", 1, "It says milk."),
        buildStoredFragmentPartMatcher("text", 1, "Found it. Buy milk.")
      ])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-2)).toMatchObject({
        role: "assistant",
        content: "Let me look."
      })
    })

    it("stores no text part for a round with only calls and starts the next round's text in a part of its own", async () => {
      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(
          [
            { type: "text", content: "Let me look." },
            {
              type: "tool-calls",
              toolCalls: [
                { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
              ]
            }
          ],
          [
            {
              type: "tool-calls",
              toolCalls: [
                { toolName: "read_text_file", argumentText: '{"path":"/b"}' }
              ]
            }
          ],
          [
            { type: "text", content: "Found it." },
            { type: "finish", finishReason: "stop" }
          ]
        ),
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "Buy milk"
        })
      })

      expect(run.parts.map((part) => [part.kind, part.round] as const)).toEqual(
        [
          ["text", 0],
          ["tool-call", 0],
          ["tool-call", 1],
          ["text", 2]
        ]
      )
    })

    it("stores a failed result and hands the model its content", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
            ]
          }
        ],
        [{ type: "finish", finishReason: "stop" }]
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "failed",
          reason: "toolFailed",
          content: "The file /a no longer exists."
        })
      })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: "The file /a no longer exists."
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "failed",
          result: "The file /a no longer exists."
        })
      ])
    })

    it("interrupts without another round, and marks the call interrupted, when the reply is stopped while a call waits", async () => {
      const cancellation = new AbortController()
      const openReplyStream = createRoundStreams([
        { type: "text", content: "Let me look." },
        {
          type: "tool-calls",
          toolCalls: [
            { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
          ]
        }
      ])

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => {
          cancellation.abort()
          return undefined
        }
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([
        buildStoredFragmentPartMatcher("text", 0, "Let me look."),
        expect.objectContaining({ kind: "tool-call", status: "interrupted" })
      ])
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ kind: "text", content: "Let me look." }),
        buildReplyPartEventMatcher({ kind: "tool-call", status: "running" }),
        INTERRUPTED_EVENT
      ])
    })

    it("interrupts without sending a call the store refused because a newer turn finalized the reply", async () => {
      const store = openAgentTurnStore()
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()
      const openReplyStream = createRoundStreams(READ_A_ROUND)

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall,
        createToolCallGate: async () => {
          store.services.turns.updateAssistantMessageState(store.replyId, {
            status: "interrupted"
          })
          return new ToolCallGate(new Set(["read_text_file"]), vi.fn())
        }
      })

      expect(sendClientToolCall).not.toHaveBeenCalled()
      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([])
      expect(run.events).toEqual([INTERRUPTED_EVENT])
    })
  })

  describe("results of tools that reach the network", () => {
    it("removes invisible characters from a backend tool's result, says how many, and stores the cleaned result", async () => {
      const { entry } = createLookUpWordTool(async (word) => ({
        status: "succeeded",
        content: `${word}:\u200B a night\u2066 insect`,
        sources: []
      }))
      const openReplyStream = createRoundStreams(
        LOOK_UP_MOTH_ROUND,
        FINISH_ROUND
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        builtInTools: [entry]
      })

      const cleaned =
        "moth: a night insect\n\nLys removed 2 invisible characters from this result."
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: cleaned
      })
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "succeeded", result: cleaned })
      ])
    })

    it("removes invisible characters from a backend tool's failed run", async () => {
      const { entry } = createLookUpWordTool(async () => ({
        status: "failed",
        content: "The dictionary said:\u202E stop"
      }))
      const openReplyStream = createRoundStreams(
        LOOK_UP_MOTH_ROUND,
        FINISH_ROUND
      )

      await getAgentReplyOutcome({
        openReplyStream,
        builtInTools: [entry]
      })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content:
          "The dictionary said: stop\n\nLys removed 1 invisible character from this result."
      })
    })

    it("removes invisible characters from a client tool that reaches the network", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "fetch_note", argumentText: '{"id":"moths"}' }
            ]
          }
        ],
        FINISH_ROUND
      )

      await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [FETCH_NOTE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "Moths\u200B fly at night."
        })
      })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content:
          "Moths fly at night.\n\nLys removed 1 invisible character from this result."
      })
    })

    it("leaves the result of a tool that only reads this machine as it is", async () => {
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
            ]
          }
        ],
        FINISH_ROUND
      )

      await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "Moths\u200B fly at night."
        })
      })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: "Moths\u200B fly at night."
      })
    })
  })

  describe("backend tool calls", () => {
    it("offers client tools before backend tools and runs an allowed call under the turn's signal", async () => {
      const cancellation = new AbortController()
      const runSignals: AbortSignal[] = []
      const { entry } = createLookUpWordTool(async (word, context) => {
        runSignals.push(context.abortSignal)
        return {
          status: "succeeded",
          content: `${word}: a night insect`,
          sources: []
        }
      })
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND, [
        { type: "text", content: "A moth is a night insect." },
        { type: "finish", finishReason: "stop" }
      ])

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        clientTools: [READ_TEXT_FILE_TOOL],
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt
      })

      expect(openReplyStream.mock.calls[0]?.[0].tools).toEqual([
        READ_TEXT_FILE_FORMAT,
        LOOK_UP_WORD_FORMAT
      ])
      expect(sendToolApprovalPrompt.mock.calls).toEqual([
        [
          {
            id: expect.stringMatching(UUID_V7_PATTERN),
            toolName: "look_up_word",
            arguments: { word: "moth" }
          }
        ]
      ])
      expect(runSignals).toEqual([cancellation.signal])
      const promptedCallId = sendToolApprovalPrompt.mock.calls[0]?.[0].id
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: promptedCallId,
        content: "moth: a night insect"
      })
      expect(run.events.at(-1)).toEqual({ type: "done", finishReason: "stop" })
    })

    it("sends an allowed backend call's states, then the next round's text", async () => {
      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(LOOK_UP_MOTH_ROUND, [
          { type: "text", content: "A moth is a night insect." },
          { type: "finish", finishReason: "stop" }
        ]),
        builtInTools: [createLookUpWordTool().entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: createAllowingPromptSender()
      })

      const callId = run.parts[0]?.id
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({
          id: callId,
          toolName: "look_up_word",
          status: "awaiting-approval"
        }),
        buildReplyPartEventMatcher({ id: callId, status: "running" }),
        buildReplyPartEventMatcher({
          id: callId,
          status: "succeeded",
          result: "moth: a definition"
        }),
        buildReplyPartEventMatcher({
          kind: "text",
          round: 1,
          content: "A moth is a night insect."
        }),
        { type: "done", finishReason: "stop" }
      ])
    })

    it("runs a call of a tool saved as Just run without prompting the person", async () => {
      const { tool, entry } = createLookUpWordTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()

      await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(LOOK_UP_MOTH_ROUND, FINISH_ROUND),
        builtInTools: [entry],
        justRunToolNames: ["look_up_word"],
        sendToolApprovalPrompt
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(tool.startedWords).toEqual(["moth"])
    })

    it("runs a call of a tool that runs without approval at once, never asking the gate or the person", async () => {
      const { tool, entry } = createLookUpWordTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const createToolCallGate = vi.fn<AgentTurn["createToolCallGate"]>(
        async () => new ToolCallGate(new Set(), sendToolApprovalPrompt)
      )

      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(LOOK_UP_MOTH_ROUND, FINISH_ROUND),
        builtInTools: [{ ...entry, runsWithoutApproval: true }],
        createToolCallGate,
        sendToolApprovalPrompt
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(createToolCallGate).not.toHaveBeenCalled()
      expect(tool.startedWords).toEqual(["moth"])
      const callId = run.parts[0]?.id
      expect(run.events.slice(0, 2)).toEqual([
        buildReplyPartEventMatcher({
          id: callId,
          toolName: "look_up_word",
          status: "running"
        }),
        buildReplyPartEventMatcher({ id: callId, status: "succeeded" })
      ])
      expect(run.parts[0]).toMatchObject({ status: "succeeded" })
    })

    it("creates the round's gate once when a call that runs without approval shares the round with one that passes the gate", async () => {
      const { tool, entry } = createLookUpWordTool()
      const createToolCallGate = vi.fn<AgentTurn["createToolCallGate"]>(
        async () =>
          new ToolCallGate(
            new Set(["read_text_file"]),
            handleUnexpectedToolCall
          )
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>(
        async () => ({ status: "succeeded", content: "x" })
      )

      await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(
          [
            {
              type: "tool-calls",
              toolCalls: [
                { toolName: "look_up_word", argumentText: '{"word":"moth"}' },
                { toolName: "read_text_file", argumentText: '{"path":"/a"}' }
              ]
            }
          ],
          FINISH_ROUND
        ),
        clientTools: [READ_TEXT_FILE_TOOL],
        builtInTools: [{ ...entry, runsWithoutApproval: true }],
        createToolCallGate,
        sendClientToolCall
      })

      expect(createToolCallGate).toHaveBeenCalledTimes(1)
      expect(tool.startedWords).toEqual(["moth"])
      expect(sendClientToolCall).toHaveBeenCalledTimes(1)
    })

    it("answers arguments the tool cannot run without prompting the person", async () => {
      const { tool, entry } = createLookUpWordTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "look_up_word", argumentText: '{"word":"unknown"}' }
            ]
          }
        ],
        FINISH_ROUND
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(tool.startedWords).toEqual([])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: "Cannot look up unknown."
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "failed",
          result: "Cannot look up unknown."
        })
      ])
    })

    it("stores the person's rejection and hands it to the model without running the tool", async () => {
      const { tool, entry } = createLookUpWordTool()
      const openReplyStream = createRoundStreams(
        LOOK_UP_MOTH_ROUND,
        FINISH_ROUND
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => DECLINED_APPROVAL
      })

      expect(tool.startedWords).toEqual([])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: DECLINED_APPROVAL.content
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "rejected",
          result: DECLINED_APPROVAL.content
        })
      ])
    })

    it("interrupts without running the tool, and marks the waiting call interrupted, when the reply is stopped while the prompt waits", async () => {
      const cancellation = new AbortController()
      const { tool, entry } = createLookUpWordTool()
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => {
          cancellation.abort()
          return undefined
        }
      })

      expect(tool.startedWords).toEqual([])
      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "awaiting-approval" }),
        INTERRUPTED_EVENT
      ])
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
    })

    it("interrupts without another round when the reply is stopped while the tool runs", async () => {
      const cancellation = new AbortController()
      const { entry } = createLookUpWordTool(async (_word, context) => {
        cancellation.abort()
        context.abortSignal.throwIfAborted()
        return { status: "succeeded", content: "too late", sources: [] }
      })
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        builtInTools: [entry]
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "running" }),
        INTERRUPTED_EVENT
      ])
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
      expect(run.reportedFailures).toEqual([])
      expect(run.reportedCancellations).toEqual([])
    })

    it("fails the reply when the tool's run rejects although the reply was not stopped", async () => {
      const defect = new Error("tool defect")
      const { entry } = createLookUpWordTool(async () => {
        throw defect
      })

      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(LOOK_UP_MOTH_ROUND),
        builtInTools: [entry]
      })

      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "running" }),
        CHAT_FAILURE_EVENT
      ])
      expect(run.reportedFailures).toEqual([defect])
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
    })
  })

  describe("MCP tool calls", () => {
    it("offers MCP tools after client and backend tools, asks the person, and runs an allowed call on its server under the turn's signal", async () => {
      const cancellation = new AbortController()
      const { tool, call } = createMcpEchoTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const openReplyStream = createRoundStreams(ECHO_MOTH_ROUND, FINISH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        clientTools: [READ_TEXT_FILE_TOOL],
        builtInTools: [createLookUpWordTool().entry],
        mcpTools: [tool],
        justRunToolNames: [],
        sendToolApprovalPrompt
      })

      expect(
        openReplyStream.mock.calls[0]?.[0].tools.map(
          (format) => format.function.name
        )
      ).toEqual(["read_text_file", "look_up_word", "mcp__files__echo"])
      expect(sendToolApprovalPrompt.mock.calls).toEqual([
        [
          {
            id: expect.stringMatching(UUID_V7_PATTERN),
            toolName: "mcp__files__echo",
            arguments: { text: "moth" }
          }
        ]
      ])
      expect(call.mock.calls).toEqual([[{ text: "moth" }, cancellation.signal]])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: 'echo: {"text":"moth"}'
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "succeeded",
          result: 'echo: {"text":"moth"}'
        })
      ])
    })

    it("runs an MCP tool's call saved as Just run without prompting the person", async () => {
      const { tool, call } = createMcpEchoTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()

      await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(ECHO_MOTH_ROUND, FINISH_ROUND),
        mcpTools: [tool],
        justRunToolNames: ["mcp__files__echo"],
        sendToolApprovalPrompt
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(call).toHaveBeenCalledOnce()
    })

    it("stores a call the server failed as failed and hands its text to the model", async () => {
      const { tool } = createMcpEchoTool(async () => ({
        status: "failed",
        content: "The server said it broke."
      }))
      const openReplyStream = createRoundStreams(ECHO_MOTH_ROUND, FINISH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        mcpTools: [tool]
      })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: "The server said it broke."
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "failed",
          result: "The server said it broke."
        })
      ])
    })

    it("removes invisible characters from an MCP tool's result, since Lys cannot tell what it reached", async () => {
      const { tool } = createMcpEchoTool(async () => ({
        status: "succeeded",
        content: "moth\u200B fly"
      }))
      const openReplyStream = createRoundStreams(ECHO_MOTH_ROUND, FINISH_ROUND)

      await getAgentReplyOutcome({ openReplyStream, mcpTools: [tool] })

      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content:
          "moth fly\n\nLys removed 1 invisible character from this result."
      })
    })

    it("stores the person's rejection and hands it to the model without calling the server", async () => {
      const { tool, call } = createMcpEchoTool()
      const openReplyStream = createRoundStreams(ECHO_MOTH_ROUND, FINISH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        mcpTools: [tool],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => DECLINED_APPROVAL
      })

      expect(call).not.toHaveBeenCalled()
      expect(run.parts).toEqual([
        expect.objectContaining({
          status: "rejected",
          result: DECLINED_APPROVAL.content
        })
      ])
    })

    it("answers arguments without a name the tool requires without prompting the person or calling the server", async () => {
      const { tool, call } = createMcpEchoTool()
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "mcp__files__echo", argumentText: '{"other":1}' }
            ]
          }
        ],
        FINISH_ROUND
      )

      const run = await getAgentReplyOutcome({
        openReplyStream,
        mcpTools: [tool],
        justRunToolNames: [],
        sendToolApprovalPrompt
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      expect(run.parts).toEqual([expect.objectContaining({ status: "failed" })])
    })

    it("interrupts without another round when the reply is stopped while the server runs the call", async () => {
      const cancellation = new AbortController()
      const { tool } = createMcpEchoTool(async (_arguments, abortSignal) => {
        cancellation.abort()
        abortSignal.throwIfAborted()
        return { status: "succeeded", content: "too late" }
      })
      const openReplyStream = createRoundStreams(ECHO_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        mcpTools: [tool]
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
      expect(run.reportedFailures).toEqual([])
    })

    it("fails the reply when an MCP call rejects although the reply was not stopped", async () => {
      const defect = new Error("registry defect")
      const { tool } = createMcpEchoTool(async () => {
        throw defect
      })

      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(ECHO_MOTH_ROUND),
        mcpTools: [tool]
      })

      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.reportedFailures).toEqual([defect])
    })
  })

  describe("sources", () => {
    it("numbers the sources a backend tool shows after the conversation's, stores them, and sends them before the call that shows them", async () => {
      const earlierSource = {
        number: 4,
        url: "https://earlier.example/",
        title: "Earlier"
      }
      const { entry } = createLookUpWordTool(runLookUpWordWithSource)
      const openReplyStream = createRoundStreams(
        LOOK_UP_MOTH_ROUND,
        FINISH_ROUND
      )

      const run = await getAgentReplyOutcome({
        store: openAgentTurnStore([earlierSource]),
        openReplyStream,
        builtInTools: [entry]
      })

      const newSource = {
        number: 5,
        url: "https://words.example/moth",
        title: "Dictionary: moth"
      }
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "running" }),
        { type: "sources", sources: [newSource] },
        buildReplyPartEventMatcher({ status: "succeeded", sourceNumbers: [5] }),
        { type: "done", finishReason: "stop" }
      ])
      expect(run.sources).toEqual([earlierSource, newSource])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: "moth: a definition. Source [5]"
      })
    })

    it("gives a URL the number it has in the conversation and stores it once", async () => {
      const knownSource = {
        number: 2,
        url: "https://words.example/moth",
        title: "Moths, the stored title"
      }
      const { entry } = createLookUpWordTool(runLookUpWordWithSource)

      const run = await getAgentReplyOutcome({
        store: openAgentTurnStore([knownSource]),
        openReplyStream: createRoundStreams(LOOK_UP_MOTH_ROUND, FINISH_ROUND),
        builtInTools: [entry]
      })

      expect(run.events).toContainEqual({
        type: "sources",
        sources: [knownSource]
      })
      expect(run.parts).toEqual([
        expect.objectContaining({
          result: "moth: a definition. Source [2]",
          sourceNumbers: [2]
        })
      ])
      expect(run.sources).toEqual([knownSource])
    })

    it("gives a URL one number across the calls and rounds of a turn", async () => {
      const { entry } = createLookUpWordTool(runLookUpWordWithSource)

      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(
          [
            {
              type: "tool-calls",
              toolCalls: [
                { toolName: "look_up_word", argumentText: '{"word":"moth"}' },
                { toolName: "look_up_word", argumentText: '{"word":"lamp"}' }
              ]
            }
          ],
          LOOK_UP_MOTH_ROUND,
          FINISH_ROUND
        ),
        builtInTools: [entry]
      })

      expect(
        run.parts.map((part) =>
          part.kind === "tool-call" && part.status === "succeeded"
            ? part.sourceNumbers
            : []
        )
      ).toEqual([[1], [2], [1]])
      expect(run.sources.map((source) => source.url)).toEqual([
        "https://words.example/moth",
        "https://words.example/lamp"
      ])
    })

    it("stores no source for a client tool's result", async () => {
      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(READ_A_ROUND, FINISH_ROUND),
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => ({
          status: "succeeded",
          content: "See https://moths.example/"
        })
      })

      expect(run.events.some((event) => event.type === "sources")).toBe(false)
      expect(run.sources).toEqual([])
    })
  })

  describe("tool call approval", () => {
    it("stores a call as awaiting approval before its prompt is sent", async () => {
      const store = openAgentTurnStore()
      const storedAtPrompt: (readonly ReplyPart[])[] = []

      await getAgentReplyOutcome({
        store,
        openReplyStream: createRoundStreams(READ_A_ROUND, FINISH_ROUND),
        clientTools: [READ_TEXT_FILE_TOOL],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => {
          storedAtPrompt.push(getStoredReply(store).reply.parts)
          return { status: "allowed" }
        },
        sendClientToolCall: async () => ({ status: "succeeded", content: "" })
      })

      expect(storedAtPrompt).toEqual([
        [expect.objectContaining({ status: "awaiting-approval" })]
      ])
    })

    it("sends no prompt for a call the store refused because a newer turn ended the reply", async () => {
      const store = openAgentTurnStore()
      const sendToolApprovalPrompt = vi.fn<SendToolApprovalPrompt>()

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream: createRoundStreams(READ_A_ROUND),
        clientTools: [READ_TEXT_FILE_TOOL],
        createToolCallGate: async () => {
          updateStoredReplyToInterrupted(store)
          return new ToolCallGate(new Set(), sendToolApprovalPrompt)
        }
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(run.events).toEqual([INTERRUPTED_EVENT])
    })

    it("prompts the person for a client tool on Ask me and sends the call to run once allowed, under the prompt's identifier", async () => {
      const sent: string[] = []
      const sendToolApprovalPrompt = vi.fn<SendToolApprovalPrompt>(
        async (toolCall) => {
          sent.push(`prompt ${toolCall.id}`)
          return { status: "allowed" }
        }
      )
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>(
        async (toolCall) => {
          sent.push(`run ${toolCall.id}`)
          return { status: "succeeded", content: "Buy milk" }
        }
      )
      const openReplyStream = createRoundStreams(READ_A_ROUND, FINISH_ROUND)

      await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        justRunToolNames: [],
        sendToolApprovalPrompt,
        sendClientToolCall
      })

      const callId = sendToolApprovalPrompt.mock.calls[0]?.[0].id
      expect(sent).toEqual([`prompt ${callId}`, `run ${callId}`])
      expect(sendClientToolCall.mock.calls).toEqual([
        [{ id: callId, toolName: "read_text_file", arguments: { path: "/a" } }]
      ])
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: callId,
        content: "Buy milk"
      })
    })

    it("hands the model the person's rejection without sending the client tool's call to run", async () => {
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()
      const openReplyStream = createRoundStreams(READ_A_ROUND, FINISH_ROUND)

      await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => DECLINED_APPROVAL,
        sendClientToolCall
      })

      expect(sendClientToolCall).not.toHaveBeenCalled()
      expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
        role: "tool",
        content: DECLINED_APPROVAL.content
      })
    })

    it("sends a round's prompts and run requests in the model's order", async () => {
      const sent: string[] = []
      const { entry } = createLookUpWordTool()
      const openReplyStream = createRoundStreams(
        [
          {
            type: "tool-calls",
            toolCalls: [
              { toolName: "read_text_file", argumentText: '{"path":"/a"}' },
              { toolName: "look_up_word", argumentText: '{"word":"moth"}' },
              { toolName: "read_text_file", argumentText: '{"path":"/b"}' }
            ]
          }
        ],
        FINISH_ROUND
      )

      await getAgentReplyOutcome({
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        builtInTools: [entry],
        justRunToolNames: ["read_text_file"],
        sendToolApprovalPrompt: async (toolCall) => {
          sent.push(`prompt ${String(toolCall.arguments.word)}`)
          return { status: "allowed" }
        },
        sendClientToolCall: async (toolCall) => {
          sent.push(`run ${String(toolCall.arguments.path)}`)
          return { status: "succeeded", content: "text" }
        }
      })

      expect(sent).toEqual(["run /a", "prompt moth", "run /b"])
    })

    it("creates one gate per round of tool calls", async () => {
      const createToolCallGate = vi.fn<AgentTurn["createToolCallGate"]>(
        async () => new ToolCallGate(new Set(["read_text_file"]), vi.fn())
      )

      await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(
          [
            {
              type: "tool-calls",
              toolCalls: [
                { toolName: "read_text_file", argumentText: '{"path":"/a"}' },
                { toolName: "read_text_file", argumentText: '{"path":"/b"}' }
              ]
            }
          ],
          READ_A_ROUND,
          FINISH_ROUND
        ),
        clientTools: [READ_TEXT_FILE_TOOL],
        createToolCallGate,
        sendClientToolCall: async () => ({ status: "succeeded", content: "x" })
      })

      expect(createToolCallGate).toHaveBeenCalledTimes(2)
    })

    it("interrupts without prompting or running anything when the reply is stopped while the gate reads the saved choices", async () => {
      const cancellation = new AbortController()
      const sendToolApprovalPrompt = createAllowingPromptSender()
      const sendClientToolCall = vi.fn<AgentTurn["sendClientToolCall"]>()
      const openReplyStream = createRoundStreams(READ_A_ROUND)

      const run = await getAgentReplyOutcome({
        openReplyStream,
        abortSignal: cancellation.signal,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall,
        createToolCallGate: async () => {
          cancellation.abort()
          return new ToolCallGate(new Set(), sendToolApprovalPrompt)
        }
      })

      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
      expect(sendClientToolCall).not.toHaveBeenCalled()
      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.persistedStates).toEqual([{ status: "interrupted" }])
      expect(run.events).toEqual([INTERRUPTED_EVENT])
    })

    it("fails the reply when the gate cannot be created", async () => {
      const failure = new Error("Closing settings.json failed.")

      const run = await getAgentReplyOutcome({
        openReplyStream: createRoundStreams(READ_A_ROUND),
        clientTools: [READ_TEXT_FILE_TOOL],
        createToolCallGate: async () => {
          throw failure
        }
      })

      expect(run.persistedStates).toEqual([{ status: "failed" }])
      expect(run.events).toEqual([CHAT_FAILURE_EVENT])
      expect(run.reportedFailures).toEqual([failure])
    })
  })

  describe("a reply that another writer ended while its calls were handled", () => {
    it("never runs a call the person allows after the reply ended while the prompt waited", async () => {
      const store = openAgentTurnStore()
      const { tool, entry } = createLookUpWordTool()
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream,
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => {
          updateStoredReplyToInterrupted(store)
          return { status: "allowed" }
        }
      })

      expect(tool.startedWords).toEqual([])
      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "awaiting-approval" }),
        INTERRUPTED_EVENT
      ])
    })

    it("asks the model nothing more when the person rejects a call after the reply ended while the prompt waited", async () => {
      const store = openAgentTurnStore()
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream,
        builtInTools: [createLookUpWordTool().entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => {
          updateStoredReplyToInterrupted(store)
          return DECLINED_APPROVAL
        }
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "awaiting-approval" }),
        INTERRUPTED_EVENT
      ])
    })

    it("asks the model nothing more when the reply ended while a backend tool ran", async () => {
      const store = openAgentTurnStore()
      const { entry } = createLookUpWordTool(async () => {
        updateStoredReplyToInterrupted(store)
        return { status: "succeeded", content: "A moth", sources: [] }
      })
      const openReplyStream = createRoundStreams(LOOK_UP_MOTH_ROUND)

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream,
        builtInTools: [entry]
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([
        expect.objectContaining({ status: "interrupted" })
      ])
      expect(run.events).toEqual([
        buildReplyPartEventMatcher({ status: "running" }),
        INTERRUPTED_EVENT
      ])
    })

    it("asks the model nothing more when the reply ended before a call of an unknown tool was stored, a round that creates no gate", async () => {
      const store = openAgentTurnStore()
      const openReplyStream = createRoundStreams([
        {
          type: "tool-calls",
          toolCalls: [{ toolName: "missing_tool", argumentText: "{}" }]
        }
      ])

      const run = await getAgentReplyOutcome({
        store,
        openReplyStream,
        clientTools: [READ_TEXT_FILE_TOOL],
        createToolCallGate: handleUnexpectedToolCall,
        createReplyPart: (stored) => (draft) => {
          updateStoredReplyToInterrupted(store)
          return stored(draft)
        }
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([])
      expect(run.events).toEqual([INTERRUPTED_EVENT])
    })
  })

  describe("activity", () => {
    /**
     * Creates an agent whose model records the agent's requests whenever it
     * opens a round's stream, then answers each round in turn.
     *
     * @param rounds - Events or actions of each round, in request order.
     * @returns The agent and the requests listed at each opening.
     */
    function createListingAgent(...rounds: (readonly ScriptedStreamStep[])[]) {
      const listedAtOpenings: (readonly AgentRequestState[])[] = []
      const openReplyStream = vi.fn<OpenReplyStream>()
      for (const steps of rounds)
        openReplyStream.mockImplementationOnce(async (request) => {
          listedAtOpenings.push(agent.listRequests())
          return createScriptedStream(...steps).openReplyStream(request)
        })
      const agent = createTestAgent(
        { openReplyStream },
        createRoomyReplyContextMeter()
      )
      return { agent, listedAtOpenings }
    }

    it("lists no request before a reply starts", () => {
      expect(
        createTestAgent(
          { openReplyStream: createEventStream() },
          createRoomyReplyContextMeter()
        ).listRequests()
      ).toEqual([])
    })

    it("lists a reply from its start as preparing round 0, with its reply, conversation, model, and start time", async () => {
      const store = openAgentTurnStore()
      const { agent, listedAtOpenings } = createListingAgent(FINISH_ROUND)

      await getAgentReplyOutcome({ agent, store })

      expect(listedAtOpenings).toEqual([
        [
          {
            requestId: store.replyId,
            conversationId: store.conversationId,
            model: TURN_REQUEST.model,
            startedAt: NOW,
            step: { kind: "preparing", round: 0 }
          }
        ]
      ])
    })

    it("shows the step each stored part puts the reply at, and a new round as preparing it", async () => {
      const steps: unknown[] = []
      /** Records the step the agent shows for its only request. */
      const recordStep = () => {
        steps.push(agent.listRequests()[0]?.step)
      }
      const { agent, listedAtOpenings } = createListingAgent(
        [
          { type: "reasoning", content: "Hmm" },
          recordStep,
          { type: "text", content: "Let me look." },
          recordStep,
          ...LOOK_UP_MOTH_ROUND
        ],
        FINISH_ROUND
      )
      const { entry } = createLookUpWordTool(async (word) => {
        recordStep()
        return { status: "succeeded", content: `${word}: x`, sources: [] }
      })

      await getAgentReplyOutcome({
        agent,
        builtInTools: [entry],
        justRunToolNames: [],
        sendToolApprovalPrompt: async () => {
          recordStep()
          return { status: "allowed" }
        }
      })

      /**
       * Builds the step of round 0 while its one call has a status.
       *
       * @param status - Status of the call.
       * @returns The step.
       */
      const buildCallStep = (status: string) => ({
        kind: "using-tools",
        round: 0,
        toolCalls: [
          {
            toolCallId: expect.stringMatching(UUID_V7_PATTERN),
            toolName: "look_up_word",
            status
          }
        ]
      })
      expect(steps).toEqual([
        { kind: "thinking", round: 0 },
        { kind: "writing", round: 0 },
        buildCallStep("awaiting-approval"),
        buildCallStep("running")
      ])
      expect(listedAtOpenings[1]?.[0]?.step).toEqual({
        kind: "preparing",
        round: 1
      })
    })

    it("shows a client tool's call as running in the app while the app runs it", async () => {
      const listed: (readonly AgentRequestState[])[] = []
      const { agent } = createListingAgent(READ_A_ROUND, FINISH_ROUND)

      await getAgentReplyOutcome({
        agent,
        clientTools: [READ_TEXT_FILE_TOOL],
        sendClientToolCall: async () => {
          listed.push(agent.listRequests())
          return { status: "succeeded", content: "text of /a" }
        }
      })

      expect(listed).toEqual([
        [
          expect.objectContaining({
            step: expect.objectContaining({
              toolCalls: [
                expect.objectContaining({
                  toolName: "read_text_file",
                  status: "running-in-app"
                })
              ]
            })
          })
        ]
      ])
    })

    it.each([
      ["completes", [{ type: "text", content: "Hi" }, ...FINISH_ROUND], {}],
      [
        "fails",
        [
          { type: "text", content: "Hi" },
          () => {
            throw new Error("model crashed")
          }
        ],
        {}
      ],
      [
        "has a write refused",
        [{ type: "text", content: "Hi" }],
        { createReplyPart: () => () => undefined }
      ],
      [
        "cannot store its final state",
        [{ type: "text", content: "Hi" }, ...FINISH_ROUND],
        {
          updateAssistantMessageState: () => () => {
            throw new Error("Database is closed")
          }
        }
      ]
    ] satisfies [string, ScriptedStreamStep[], AgentTurnScenario][])(
      "stops listing a reply that %s",
      async (_label, steps, turnScenario) => {
        const { agent, listedAtOpenings } = createListingAgent(steps)

        await getAgentReplyOutcome({ agent, ...turnScenario })

        expect(listedAtOpenings.map((listed) => listed.length)).toEqual([1])
        expect(agent.listRequests()).toEqual([])
      }
    )

    it("stops listing a reply that is stopped", async () => {
      const cancellation = new AbortController()
      const { agent, listedAtOpenings } = createListingAgent([
        { type: "text", content: "Hi" },
        () => {
          cancellation.abort()
        },
        { type: "text", content: " there" }
      ])

      const run = await getAgentReplyOutcome({
        agent,
        abortSignal: cancellation.signal
      })

      expect(run.events.at(-1)).toEqual(INTERRUPTED_EVENT)
      expect(listedAtOpenings.map((listed) => listed.length)).toEqual([1])
      expect(agent.listRequests()).toEqual([])
    })
  })

  describe("request slots", () => {
    /** Step of a reply that holds a slot before anything of it is stored. */
    const FIRST_ROUND_STEP = Object.freeze({ kind: "preparing", round: 0 })

    /** Step of a reply that waits for a free request slot. */
    const WAITING_STEP = Object.freeze({ kind: "waiting" })

    /**
     * Creates an agent whose model keeps each reply's first round open until
     * the case ends it.
     *
     * @param requestLimits - Request limits of the agent;
     * {@link REQUEST_LIMITS} by default.
     * @returns The agent, its stream opener and meter, the end of each round
     * opened so far in opening order (resolving it finishes the reply,
     * rejecting it fails the model), and the release of every round, which
     * also ends each later round at once.
     */
    function createHoldingAgent(
      requestLimits: AgentRequestLimits = REQUEST_LIMITS
    ) {
      const roundEnds: PromiseWithResolvers<void>[] = []
      let isReleased = false
      const openReplyStream = vi.fn<OpenReplyStream>(async () => {
        const end = Promise.withResolvers<void>()
        if (isReleased) end.resolve()
        roundEnds.push(end)
        return (async function* (): AsyncGenerator<ReplyStreamEvent> {
          await end.promise
          yield* FINISH_ROUND
        })()
      })
      const replyContextMeter = createRoomyReplyContextMeter()
      const agent = new Agent(
        { ...AGENT_PROFILE, requestLimits },
        {
          replyModel: { openReplyStream },
          replyContextMeter,
          stateReader: UNEXPECTED_STATE_READER
        }
      )
      return {
        agent,
        openReplyStream,
        replyContextMeter,
        roundEnds,
        releaseRounds: () => {
          isReleased = true
          for (const end of roundEnds) end.resolve()
        }
      }
    }

    it.each<
      readonly [
        string,
        (end: PromiseWithResolvers<void>, stop: AbortController) => void
      ]
    >([
      [
        "completes",
        (end) => {
          end.resolve()
        }
      ],
      [
        "fails",
        (end) => {
          end.reject(new Error("model crashed"))
        }
      ],
      [
        "is stopped",
        (end, stop) => {
          stop.abort()
          end.resolve()
        }
      ]
    ])(
      "makes a reply that finds every slot held wait, untouched, and starts it once a running reply %s",
      async (_label, endFirstReply) => {
        const { agent, openReplyStream, replyContextMeter, roundEnds } =
          createHoldingAgent()
        const firstStop = new AbortController()
        const first = getAgentReplyOutcome({
          agent,
          abortSignal: firstStop.signal
        })
        const second = getAgentReplyOutcome({ agent })
        const third = getAgentReplyOutcome({ agent })
        await waitForMicrotasks()
        const stepsWhileWaiting = agent
          .listRequests()
          .map((request) => request.step)
        const measuredWhileWaiting =
          replyContextMeter.findReplyContextMeasurement.mock.calls.length
        const openedWhileWaiting = openReplyStream.mock.calls.length

        const [firstEnd, secondEnd] = roundEnds
        if (firstEnd === undefined || secondEnd === undefined)
          throw new Error("The running replies did not open their rounds")
        endFirstReply(firstEnd, firstStop)
        await first
        await waitForMicrotasks()
        const stepsAfterFirst = agent
          .listRequests()
          .map((request) => request.step)
        const openedAfterFirst = openReplyStream.mock.calls.length
        secondEnd.resolve()
        roundEnds[2]?.resolve()
        const thirdOutcome = await third
        await second

        expect(stepsWhileWaiting).toEqual([
          FIRST_ROUND_STEP,
          FIRST_ROUND_STEP,
          WAITING_STEP
        ])
        expect(measuredWhileWaiting).toBe(2)
        expect(openedWhileWaiting).toBe(2)
        expect(stepsAfterFirst).toEqual([FIRST_ROUND_STEP, FIRST_ROUND_STEP])
        expect(openedAfterFirst).toBe(3)
        expect(thirdOutcome.persistedStates).toEqual([
          { status: "completed", finishReason: "stop" }
        ])
        expect(thirdOutcome.events).toEqual([
          { type: "done", finishReason: "stop" }
        ])
        expect(agent.listRequests()).toEqual([])
      }
    )

    it("ends a reply stopped while it waits for a slot as interrupted, without measuring or sending it, and frees its place in line", async () => {
      const { agent, openReplyStream, replyContextMeter, releaseRounds } =
        createHoldingAgent()
      const running = [
        getAgentReplyOutcome({ agent }),
        getAgentReplyOutcome({ agent })
      ]
      const stop = new AbortController()
      const waiting = getAgentReplyOutcome({ agent, abortSignal: stop.signal })
      await waitForMicrotasks()

      stop.abort()
      const stopped = await waiting
      const next = getAgentReplyOutcome({ agent })
      const stepsAfterStop = agent.listRequests().map((request) => request.step)
      releaseRounds()
      await Promise.all([...running, next])

      expect(stopped.persistedStates).toEqual([{ status: "interrupted" }])
      expect(stopped.events).toEqual([INTERRUPTED_EVENT])
      expect(stopped.reportedCancellations).toHaveLength(1)
      expect(stopped.reportedRefusals).toEqual([])
      expect(stopped.reportedFailures).toEqual([])
      expect(stopped.parts).toEqual([])
      expect(stepsAfterStop).toEqual([
        FIRST_ROUND_STEP,
        FIRST_ROUND_STEP,
        WAITING_STEP
      ])
      expect(
        replyContextMeter.findReplyContextMeasurement
      ).toHaveBeenCalledTimes(3)
      expect(openReplyStream).toHaveBeenCalledTimes(3)
    })

    it.each<readonly [AgentRequestLimits, string]>([
      [
        REQUEST_LIMITS,
        "This agent is already working on 2 requests, and 1 more is waiting for it, so it did not take this message. Send it again once it finishes one."
      ],
      [
        { slotCount: 1, waitingLimit: 0 },
        "This agent is already working on 1 request, so it did not take this message. Send it again once it finishes one."
      ],
      [
        { slotCount: 1, waitingLimit: 2 },
        "This agent is already working on 1 request, and 2 more are waiting for it, so it did not take this message. Send it again once it finishes one."
      ]
    ])(
      "refuses a reply when the agent's slots and line are full (%o), storing it as failed with an error event that says why",
      async (requestLimits, message) => {
        const { agent, openReplyStream, releaseRounds } =
          createHoldingAgent(requestLimits)
        const accepted = Array.from(
          { length: requestLimits.slotCount + requestLimits.waitingLimit },
          () => getAgentReplyOutcome({ agent })
        )
        await waitForMicrotasks()

        const refused = await getAgentReplyOutcome({ agent })
        const listedCount = agent.listRequests().length
        const openedCount = openReplyStream.mock.calls.length
        releaseRounds()
        await Promise.all(accepted)

        expect(refused.persistedStates).toEqual([{ status: "failed" }])
        expect(refused.events).toEqual([{ type: "error", message }])
        expect(refused.reportedRefusals).toEqual([
          expect.any(AgentRequestLimitError)
        ])
        expect(refused.reportedRefusals[0]).toHaveProperty(
          "limits",
          requestLimits
        )
        expect(refused.reportedCancellations).toEqual([])
        expect(refused.reportedFailures).toEqual([])
        expect(refused.parts).toEqual([])
        expect(listedCount).toBe(
          requestLimits.slotCount + requestLimits.waitingLimit
        )
        expect(openedCount).toBe(requestLimits.slotCount)
      }
    )

    it("measures a conversation's context while every slot is held and the line is full", async () => {
      const { agent, replyContextMeter, releaseRounds } = createHoldingAgent({
        slotCount: 1,
        waitingLimit: 0
      })
      const running = getAgentReplyOutcome({ agent })
      await waitForMicrotasks()

      const measurement = await agent.findContextMeasurement({
        trainedForToolUse: false,
        history: [],
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [],
        unofferedTools: NO_UNOFFERED_TOOLS
      })
      const listedCount = agent.listRequests().length
      releaseRounds()
      await running

      expect(measurement).toMatchObject({ contextLength: ROOMY_CONTEXT_LENGTH })
      expect(
        replyContextMeter.findReplyContextMeasurement
      ).toHaveBeenCalledTimes(2)
      expect(listedCount).toBe(1)
    })
  })

  describe("state tools", () => {
    /**
     * Lists the names of the tools one model request offered.
     *
     * @param openReplyStream - The model's stream opener.
     * @param call - Zero-based request.
     * @returns The offered function names, in offer order.
     */
    function listOfferedToolNames(
      openReplyStream: Mock<OpenReplyStream>,
      call = 0
    ): readonly string[] {
      return (
        openReplyStream.mock.calls[call]?.[0].tools.map(
          (tool) => tool.function.name
        ) ?? []
      )
    }

    it("offers a leader's state tools after the turn's tools, MCP tools included, when the model is trained for tool use", async () => {
      const openReplyStream = createRoundStreams(FINISH_ROUND)

      await getAgentReplyOutcome({
        openReplyStream,
        trainedForToolUse: true,
        clientTools: [READ_TEXT_FILE_TOOL],
        builtInTools: [createLookUpWordTool().entry],
        mcpTools: [createMcpEchoTool().tool]
      })

      expect(listOfferedToolNames(openReplyStream)).toEqual([
        "read_text_file",
        "look_up_word",
        "mcp__files__echo",
        ...LEADER_STATE_TOOL_NAMES
      ])
    })

    it("offers a member read_my_state only", async () => {
      const openReplyStream = createRoundStreams(FINISH_ROUND)
      const agent = new Agent(
        { ...AGENT_PROFILE, role: "member" },
        {
          replyModel: { openReplyStream },
          replyContextMeter: createRoomyReplyContextMeter(),
          stateReader: UNEXPECTED_STATE_READER
        }
      )

      await getAgentReplyOutcome({ agent, trainedForToolUse: true })

      expect(listOfferedToolNames(openReplyStream)).toEqual(["read_my_state"])
    })

    it("offers the state tools while tool calls are off", async () => {
      const openReplyStream = createRoundStreams(FINISH_ROUND)

      await getAgentReplyOutcome({
        openReplyStream,
        trainedForToolUse: true,
        unofferedTools: TOOL_CALLS_OFF
      })

      expect(listOfferedToolNames(openReplyStream)).toEqual(
        LEADER_STATE_TOOL_NAMES
      )
    })

    it("offers no state tool when the model is not trained for tool use", async () => {
      const openReplyStream = createRoundStreams(FINISH_ROUND)

      await getAgentReplyOutcome({
        openReplyStream,
        builtInTools: [createLookUpWordTool().entry]
      })

      expect(listOfferedToolNames(openReplyStream)).toEqual(["look_up_word"])
    })

    it.each([
      ["on", NO_UNOFFERED_TOOLS],
      ["off", TOOL_CALLS_OFF]
    ])(
      "runs a read_my_state call at once while tool calls are %s, telling the agent the reply it writes",
      async (_label, unofferedTools) => {
        const store = openAgentTurnStore()
        const findAgentState = vi.fn<AgentStateReader["findAgentState"]>(
          () => ({
            status: "found",
            state: {
              code: AGENT_PROFILE.code,
              name: "Lys",
              role: "leader",
              deletedAt: null,
              requestSlotCount: REQUEST_LIMITS.slotCount,
              requests: agent.listRequests().map((request) => ({
                ...request,
                conversationTitle: { status: "found", title: null }
              }))
            }
          })
        )
        const openReplyStream = createRoundStreams(
          [
            {
              type: "tool-calls",
              toolCalls: [{ toolName: "read_my_state", argumentText: "{}" }]
            }
          ],
          FINISH_ROUND
        )
        const agent = createTestAgent(
          { openReplyStream },
          createRoomyReplyContextMeter(),
          { listAgentMatches: handleUnexpectedToolCall, findAgentState }
        )
        const createToolCallGate = vi.fn(handleUnexpectedToolCall)

        const run = await getAgentReplyOutcome({
          agent,
          store,
          trainedForToolUse: true,
          unofferedTools,
          createToolCallGate
        })

        const result = [
          "You are Lys (code lys), a leader. As a leader you can find other agents with find_agents and read their state with read_agent_state.",
          `Now: ${NOW}.`,
          "Request slots: 1 of 2 in use.",
          `1. This reply, in this conversation: started ${NOW} (less than a minute ago) with ${TURN_REQUEST.model}; using tools: read_my_state running.`,
          "Nothing else is in progress."
        ].join("\n")
        expect(createToolCallGate).not.toHaveBeenCalled()
        expect(findAgentState).toHaveBeenCalledExactlyOnceWith(
          { code: AGENT_PROFILE.code, role: "leader" },
          AGENT_PROFILE.code
        )
        expect(run.parts[0]).toMatchObject({
          kind: "tool-call",
          toolName: "read_my_state",
          status: "succeeded",
          result
        })
        expect(openReplyStream.mock.calls[1]?.[0].messages.at(-1)).toEqual({
          role: "tool",
          toolCallId: run.parts[0]?.id,
          content: result
        })
        expect(run.events.at(-1)).toEqual({
          type: "done",
          finishReason: "stop"
        })
      }
    )

    it("measures the state tool definitions after the given tools when the model is trained for tool use", async () => {
      const trainedMeter = createCharacterReplyContextMeter(8192)
      const untrainedMeter = createCharacterReplyContextMeter(8192)
      const input = {
        history: [],
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [LOOK_UP_WORD_TOOL],
        unofferedTools: NO_UNOFFERED_TOOLS
      }

      await createTestAgent(
        { openReplyStream: createEventStream() },
        trainedMeter
      ).findContextMeasurement({ ...input, trainedForToolUse: true })
      await createTestAgent(
        { openReplyStream: createEventStream() },
        untrainedMeter
      ).findContextMeasurement({ ...input, trainedForToolUse: false })

      expect(
        trainedMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools.map(
          (tool) => tool.function.name
        )
      ).toEqual(["look_up_word", ...LEADER_STATE_TOOL_NAMES])
      expect(
        untrainedMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools
      ).toEqual([LOOK_UP_WORD_FORMAT])
    })

    it("measures only read_my_state after the given tools for a member", async () => {
      const replyContextMeter = createCharacterReplyContextMeter(8192)
      const agent = new Agent(
        { ...AGENT_PROFILE, role: "member" },
        {
          replyModel: { openReplyStream: createEventStream() },
          replyContextMeter,
          stateReader: UNEXPECTED_STATE_READER
        }
      )

      await agent.findContextMeasurement({
        trainedForToolUse: true,
        history: [],
        model: TURN_REQUEST.model,
        canSeeImages: false,
        getAttachmentImageFileStatus: handleUnexpectedImageFileLookup,
        tools: [LOOK_UP_WORD_TOOL],
        unofferedTools: NO_UNOFFERED_TOOLS
      })

      expect(
        replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools.map(
          (tool) => tool.function.name
        )
      ).toEqual(["look_up_word", "read_my_state"])
    })
  })

  describe("system prompt changes", () => {
    it("sends the prompt it held when a reply or a measurement started, even when it changes while images are read", async () => {
      const renamedPrompt = "You are Lys, renamed."
      const openReplyStream = createRoundStreams(FINISH_ROUND, FINISH_ROUND)
      const replyContextMeter = createRoomyReplyContextMeter()
      const agent = createTestAgent({ openReplyStream }, replyContextMeter)

      await getAgentReplyOutcome({
        agent,
        userMessage: PHOTO_MESSAGE,
        canSeeImages: true,
        findAttachmentImage: async () => {
          agent.updateSystemPrompt(renamedPrompt)
          return PHOTO_BYTES
        }
      })
      await getAgentReplyOutcome({ agent })
      await agent.findContextMeasurement({
        trainedForToolUse: false,
        history: [PHOTO_MESSAGE],
        model: TURN_REQUEST.model,
        canSeeImages: true,
        getAttachmentImageFileStatus: async () => {
          agent.updateSystemPrompt("You are Lys, renamed twice.")
          return "stored"
        },
        tools: [],
        unofferedTools: NO_UNOFFERED_TOOLS
      })

      expect(
        openReplyStream.mock.calls.map(
          ([request]) => request.messages[0]?.content
        )
      ).toEqual([
        formatSystemPrompt(AGENT_PROFILE.systemPrompt, NO_UNOFFERED_TOOLS),
        formatSystemPrompt(renamedPrompt, NO_UNOFFERED_TOOLS)
      ])
      expect(
        replyContextMeter.findReplyContextMeasurement.mock.calls.at(-1)?.[0]
          .messages[0]?.content
      ).toBe(formatSystemPrompt(renamedPrompt, NO_UNOFFERED_TOOLS))
    })
  })
})
