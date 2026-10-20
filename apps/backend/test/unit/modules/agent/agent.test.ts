import { isDeepStrictEqual } from "node:util"
import type {
  ChatGenerationEvent,
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"
import {
  toolDefinitionSchema,
  type ConversationAssistantMessage,
  type ConversationMessage,
  type ConversationSource,
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
  type AgentTurn,
  type AssistantMessageCompletion
} from "../../../../src/modules/agent/agent"
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
import type { TurnBuiltInTool } from "../../../../src/modules/tool/builtIn/builtInTool"
import ToolCallGate, {
  type SendToolApprovalPrompt
} from "../../../../src/modules/toolApproval/toolCallGate"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import {
  openConversationTestServices,
  saveSourceRow,
  type ConversationTestServices
} from "../../support/conversationDatabase"
import {
  createAssistantMessage,
  createTextPart,
  createToolCallPart,
  createUserMessage
} from "../../support/conversationFixtures"
import {
  createRoomyReplyContextMeter,
  createUnloadedReplyContextMeter
} from "../../support/replyContextMeterFakes"
import {
  runLookUpWordWithSource,
  LOOK_UP_WORD_FORMAT,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool,
  type BuiltInToolRunScript
} from "../../support/scriptedBuiltInTool"
import {
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

/** Profile of the agent under test. */
const AGENT_PROFILE = Object.freeze({
  code: "lys",
  systemPrompt: "You are Lys."
})

/** Request values every case's turn carries. */
const TURN_REQUEST = Object.freeze({
  userMessageContent: "Hello",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4, replyCeiling: 128 }
})

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

/** Test-controlled parts of one reply. */
type AgentReplyScenario = Readonly<{
  /** Model behavior. */
  openReplyStream: OpenReplyStream
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
  /** Offered client tools; none by default. */
  clientTools?: readonly ToolDefinition[]
  /** Offered backend tools; none by default. */
  builtInTools?: readonly TurnBuiltInTool[]
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
  /** Context meter of the model; every context fits by default. */
  replyContextMeter?: ReplyContextMeter
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
    conversation: { kind: "new", agentCode: AGENT_PROFILE.code },
    userMessageContent: TURN_REQUEST.userMessageContent,
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
  const entry: TurnBuiltInTool = { definition: LOOK_UP_WORD_TOOL, tool }
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
    ...(scenario.builtInTools ?? []).map((entry) => entry.definition.name)
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
  const agent = new Agent(
    AGENT_PROFILE,
    { openReplyStream: scenario.openReplyStream },
    scenario.replyContextMeter ?? createRoomyReplyContextMeter()
  )
  const settlement = await agent
    .createReply({
      ...TURN_REQUEST,
      history: scenario.history ?? [],
      sources: getStoredReply(store).sources,
      clientTools: scenario.clientTools ?? [],
      builtInTools: scenario.builtInTools ?? [],
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
    const agent = new Agent(
      AGENT_PROFILE,
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
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer", toolCalls: [] },
        { role: "user", content: "Hello" }
      ],
      tools: [],
      model: TURN_REQUEST.model,
      generationOptions: TURN_REQUEST.generationOptions,
      abortSignal
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

  it("answers overlapping turns independently", async () => {
    const firstReplyGate = Promise.withResolvers<void>()
    const agent = new Agent(
      AGENT_PROFILE,
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
      history: [],
      sources: [],
      clientTools: [],
      builtInTools: [],
      sendClientToolCall: handleUnexpectedToolCall,
      createToolCallGate: handleUnexpectedToolCall,
      userMessageContent,
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
      const agent = new Agent(
        AGENT_PROFILE,
        { openReplyStream: createEventStream() },
        replyContextMeter
      )

      const measurement = await agent.findContextMeasurement({
        history: ANSWERED_THEN_FAILED_HISTORY,
        model: TURN_REQUEST.model,
        tools: [READ_TEXT_FILE_TOOL, LOOK_UP_WORD_TOOL]
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
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer", toolCalls: [] },
          { role: "user", content: "" }
        ],
        tools: [READ_TEXT_FILE_FORMAT, LOOK_UP_WORD_FORMAT],
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
      const agent = new Agent(
        AGENT_PROFILE,
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
        tools: []
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
      const agent = new Agent(
        AGENT_PROFILE,
        { openReplyStream: createEventStream() },
        createUnloadedReplyContextMeter()
      )

      await expect(
        agent.findContextMeasurement({
          history: [],
          model: TURN_REQUEST.model,
          tools: []
        })
      ).resolves.toBeUndefined()
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

    it("asks the model nothing more when the reply ended before a call of an unknown tool was stored", async () => {
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
        createToolCallGate: async () => {
          updateStoredReplyToInterrupted(store)
          return new ToolCallGate(new Set(), vi.fn())
        }
      })

      expect(openReplyStream).toHaveBeenCalledOnce()
      expect(run.parts).toEqual([])
      expect(run.events).toEqual([INTERRUPTED_EVENT])
    })
  })
})
