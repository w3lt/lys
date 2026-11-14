import {
  conversationIsJobProblemSchema,
  conversationNotFoundProblemSchema,
  type ListConversationsApiResponse
} from "@lys/protocol"
import type { Conversation, ConversationMetadata, Job } from "@lys/share"
import type { FastifyInstance } from "fastify"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  createConversationListCursor,
  parseConversationListOptions
} from "../../../../../src/modules/conversation/listOptions"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import AttachmentFileStore from "../../../../../src/modules/attachment/attachmentFileStore"
import type { ReplyTarget } from "../../../../../src/modules/chat/replyGenerationRegistry"
import updateFastifyWithChatRoute from "../../../../../src/modules/chat/routes/chatRoute"
import type { TurnDelegationContext } from "../../../../../src/modules/chat/turnStart"
import type {
  ListWorkingReplies,
  StopDeletedReplies
} from "../../../../../src/modules/conversation/capabilities"
import updateFastifyWithConversationRoutes from "../../../../../src/modules/conversation/routes"
import {
  listWorkingReplies,
  stopDeletedReplies
} from "../../../../../src/modules/delegation/conversationDeletions"
import {
  createChatRouteTestApp,
  sendChatRequest,
  type ChatRouteTestApp
} from "../../../support/chatRouteTestApp"
import { parseSseEvents } from "../../../support/chatSseRoute"
import ControlledReplyTask from "../../../support/controlledReplyTask"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../../support/conversationFixtures"
import {
  listJobReportRows,
  openConversationTestServices,
  type ConversationTestServices
} from "../../../support/conversationDatabase"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  startPersonTurn,
  type JobMessageRequest
} from "../../../support/delegationTestServices"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { waitForMicrotasks } from "../../../support/microtasks"

/** Identity of the conversation the stubbed history answers for. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Identity that the stubbed history reports as absent. */
const MISSING_CONVERSATION_ID = createFixtureUuidV7(404)

/** Metadata of {@link CONVERSATION_ID} returned by the stubbed history. */
const CONVERSATION_METADATA = Object.freeze({
  id: CONVERSATION_ID,
  title: "Trip plan",
  agentCode: "lys",
  kind: "main",
  parentConversationId: null,
  jobNumber: null,
  delegatorAgentCode: null,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
} satisfies ConversationMetadata)

/** Identity of the job the stubbed history answers for. */
const JOB_ID = createFixtureUuidV7(7)

/**
 * Metadata of {@link JOB_ID}, a job of {@link CONVERSATION_ID}, returned by
 * the stubbed history.
 */
const JOB_METADATA = Object.freeze({
  id: JOB_ID,
  title: "Find what moths eat",
  agentCode: "researcher",
  kind: "job",
  parentConversationId: CONVERSATION_ID,
  jobNumber: 1,
  delegatorAgentCode: "lys",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
} satisfies ConversationMetadata)

/** One-conversation page returned by the stubbed history. */
const CONVERSATION_PAGE = Object.freeze({
  conversations: [
    {
      id: CONVERSATION_ID,
      title: "Trip plan",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      preview: { role: "assistant", content: "Here is a plan" }
    }
  ],
  storedCount: 3,
  matchCount: 1,
  nextCursor: null
} satisfies ListConversationsApiResponse)

/**
 * Fails a history call that the current case did not arrange.
 *
 * @param operationName - History operation that was called.
 * @throws Always.
 */
function handleUnexpectedHistoryCall(operationName: string): never {
  throw new Error(`Unexpected conversation history call: ${operationName}`)
}

/**
 * Creates a real attachment file store over a directory created for the
 * test, which is removed when the test finishes.
 *
 * @returns The store and its directory.
 */
function createTestAttachmentFileStore() {
  const attachmentsDirectoryPath = mkdtempSync(
    join(tmpdir(), "lys-conversation-routes-attachments-")
  )
  onTestFinished(() => {
    rmSync(attachmentsDirectoryPath, { recursive: true, force: true })
  })
  const attachmentFileStore = new AttachmentFileStore(attachmentsDirectoryPath)
  return { attachmentFileStore, attachmentsDirectoryPath }
}

/**
 * Replaces each history operation the conversation routes can call with a
 * spy that throws until the case configures it.
 *
 * @param historyReader - History reader the routes read.
 * @param historyEditor - History editor the routes read.
 * @returns A spy for each of those operations, by operation name.
 */
function spyOnHistoryCalls(
  historyReader: ConversationTestServices["history"],
  historyEditor: ConversationTestServices["editor"]
) {
  return {
    listConversations: vi
      .spyOn(historyReader, "listConversations")
      .mockImplementation(() =>
        handleUnexpectedHistoryCall("listConversations")
      ),
    getConversation: vi
      .spyOn(historyReader, "getConversation")
      .mockImplementation(() => handleUnexpectedHistoryCall("getConversation")),
    getConversationMetadata: vi
      .spyOn(historyReader, "getConversationMetadata")
      .mockImplementation(() =>
        handleUnexpectedHistoryCall("getConversationMetadata")
      ),
    updateConversationTitle: vi
      .spyOn(historyEditor, "updateConversationTitle")
      .mockImplementation(() =>
        handleUnexpectedHistoryCall("updateConversationTitle")
      ),
    deleteConversation: vi
      .spyOn(historyEditor, "deleteConversation")
      .mockImplementation(() =>
        handleUnexpectedHistoryCall("deleteConversation")
      )
  }
}

/**
 * Creates an application with the HTTP transport and the conversation routes
 * registered over a stubbed history reader and editor, a recording listing
 * and cancellation of a deleted conversation's work, and a real attachment
 * file store.
 *
 * @returns The application, the destination of its log, a spy for each
 * history operation the routes can call, a spy for the listing and one for
 * the cancellation of a deleted conversation's work, and the attachment
 * file store with its directory.
 * @remarks The routes read the decorated history reader and editor at
 * registration, so the returned spies control every outcome. Each spy throws
 * until the case configures it; no database row is read or written. The
 * listing finds no working reply, and the cancellation ends at once, until
 * the case configures them. The in-memory database behind the decorated adapters
 * is closed when the test finishes, and the attachments directory, created
 * for the test, is removed.
 */
async function createConversationRouteApp() {
  const testFastify = createTestFastify()
  const { history: historyReader, editor: historyEditor } =
    openConversationTestServices()
  const { attachmentFileStore, attachmentsDirectoryPath } =
    createTestAttachmentFileStore()
  const deletionCalls = {
    listWorkingReplies: vi.fn<ListWorkingReplies>(() => []),
    stopDeletedReplies: vi.fn<StopDeletedReplies>(() => Promise.resolve())
  }
  const historyCalls = spyOnHistoryCalls(historyReader, historyEditor)
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationHistoryReader", historyReader)
  testFastify.app.decorate("conversationHistoryEditor", historyEditor)
  testFastify.app.decorate(
    "listWorkingReplies",
    deletionCalls.listWorkingReplies
  )
  testFastify.app.decorate(
    "stopDeletedReplies",
    deletionCalls.stopDeletedReplies
  )
  testFastify.app.decorate("attachmentFileStore", attachmentFileStore)
  await updateFastifyWithConversationRoutes(testFastify.app)
  return {
    ...testFastify,
    historyCalls,
    deletionCalls,
    attachmentFileStore,
    attachmentsDirectoryPath
  }
}

/**
 * Creates an application with the HTTP transport and the conversation routes
 * registered over the conversation services and the delegation runtime of
 * one case's delegation test services, and a real attachment file store.
 *
 * @returns The application, the destination of its log, and the case's
 * delegation test services.
 * @remarks The decorated history reader and editor are the services' own,
 * on the database the runtime's job records read and write. The listing and
 * cancellation of a deleted conversation's work are bound to the runtime as
 * the composition root binds the backend's own, so a delete cancels the generations the services' turn
 * start, or the case, registered. The attachments directory, created for
 * the test, is removed when it finishes.
 */
async function createDelegationRouteApp() {
  const testFastify = createTestFastify()
  const services = openDelegationTestServices()
  const { attachmentFileStore } = createTestAttachmentFileStore()
  await updateFastifyWithHttpTransport(testFastify.app)
  const { app } = testFastify
  app.decorate("conversationHistoryReader", services.conversation.history)
  app.decorate("conversationHistoryEditor", services.conversation.editor)
  app.decorate("listWorkingReplies", (conversationId) =>
    listWorkingReplies(services.runtime, conversationId)
  )
  app.decorate("stopDeletedReplies", (conversationId, replies) =>
    stopDeletedReplies(services.runtime, conversationId, replies)
  )
  app.decorate("attachmentFileStore", attachmentFileStore)
  await updateFastifyWithConversationRoutes(app)
  return { ...testFastify, services }
}

/**
 * Opens the stream of a model that holds its first piece: the stream sends
 * nothing until its request is cancelled, then fails with the request's
 * abort reason, as the body of a cancelled request does.
 *
 * @param signal - Cancellation of the request that opened the stream.
 * @returns The open stream.
 * @throws If the request cannot be cancelled, so the stream would never end.
 */
function openHeldModelStream(
  signal: AbortSignal | undefined
): AsyncIterable<ChatCompletionChunk> {
  if (signal === undefined)
    throw new Error("The model request cannot be cancelled")
  return new ReadableStream<ChatCompletionChunk>({
    start: (controller) => {
      signal.addEventListener(
        "abort",
        () => {
          controller.error(signal.reason)
        },
        { once: true }
      )
    }
  })
}

/**
 * Holds a title request whose answer the model has not sent: the request
 * stays open until it is cancelled.
 *
 * @param signal - Cancellation of the request.
 * @returns A promise that never resolves; it rejects with the request's
 * abort reason once the request is cancelled, as the platform `fetch` does,
 * or at once when the request cannot be cancelled.
 */
function holdTitleRequest(signal: AbortSignal | undefined): Promise<string> {
  if (signal === undefined)
    return Promise.reject(new Error("The title request cannot be cancelled"))
  const cancellation = Promise.withResolvers<string>()
  signal.addEventListener(
    "abort",
    () => {
      cancellation.reject(signal.reason)
    },
    { once: true }
  )
  return cancellation.promise
}

/**
 * Creates the chat route test app with the chat route and the conversation
 * routes registered, whose turns are stored for real and whose model holds
 * the first piece of every reply and the answer to every title request
 * until the request is cancelled.
 *
 * @returns The test application.
 */
async function createHeldModelChatApp(): Promise<ChatRouteTestApp> {
  const testApp = await createChatRouteTestApp()
  testApp.createConversationTurn.mockRestore()
  testApp.completeChatStream.mockImplementation(({ signal }) =>
    Promise.resolve(openHeldModelStream(signal))
  )
  testApp.generateTitle.mockImplementation(({ signal }) =>
    holdTitleRequest(signal)
  )
  updateFastifyWithChatRoute(testApp.app, testApp.findModelCapabilities)
  await updateFastifyWithConversationRoutes(testApp.app)
  return testApp
}

/**
 * Finds the only main conversation an application stores.
 *
 * @param app - Application whose history reader lists the conversations.
 * @returns UUIDv7 of the conversation.
 * @throws If the application stores no main conversation, or more than one.
 */
function findOnlyConversationId(app: FastifyInstance): string {
  const { conversations } = app.conversationHistoryReader.listConversations(
    parseConversationListOptions()
  )
  const [conversation] = conversations
  if (conversation === undefined || conversations.length > 1)
    throw new Error("The application does not store exactly one conversation")
  return conversation.id
}

/**
 * Builds the address of a turn's reply.
 *
 * @param context - The stored turn.
 * @returns The frozen address of the turn's reply in its conversation.
 */
function buildReplyTarget(context: TurnDelegationContext): ReplyTarget {
  return Object.freeze({
    conversationId: context.turn.conversation.id,
    assistantMessageId: context.turn.assistantMessage.id
  })
}

/**
 * Builds the address of a job's reply.
 *
 * @param job - The job, as stored.
 * @returns The frozen address of the job's reply in the job's conversation.
 */
function buildJobReplyTarget(job: Job): ReplyTarget {
  return Object.freeze({
    conversationId: job.id,
    assistantMessageId: job.replyId
  })
}

describe("updateFastifyWithConversationRoutes", () => {
  describe("GET /api/v1/conversations", () => {
    it("responds with the page read from history", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.listConversations.mockReturnValue(CONVERSATION_PAGE)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(CONVERSATION_PAGE)
      expect(historyCalls.listConversations).toHaveBeenCalledOnce()
      expect(historyCalls.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ query: "", cursor: undefined })
      )
    })

    it("reads the page for the search query and page size", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.listConversations.mockReturnValue(CONVERSATION_PAGE)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "  trip  ", limit: "1" }
      })

      expect(response.statusCode).toBe(200)
      expect(historyCalls.listConversations).toHaveBeenCalledWith({
        query: "trip",
        cursor: undefined,
        limit: 1
      })
    })

    it("responds with a server error when the page cannot be read", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.listConversations.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations"
      })

      expect(response.statusCode).toBe(500)
    })

    it.each([
      ["an empty search query", { query: "  " }],
      ["a page size above the maximum", { limit: "51" }],
      ["an unknown parameter", { sort: "title" }]
    ])("rejects %s", async (_label, query) => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.listConversations).not.toHaveBeenCalled()
    })

    it("rejects a cursor issued for another query as invalid input", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      const cursor = createConversationListCursor("budget", {
        id: createFixtureUuidV7(1),
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        preview: null
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "trip", cursor }
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.listConversations).not.toHaveBeenCalled()

      historyCalls.listConversations.mockReturnValue(CONVERSATION_PAGE)
      const matchingQueryResponse = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "budget", cursor }
      })

      expect(matchingQueryResponse.statusCode).toBe(200)
      expect(historyCalls.listConversations).toHaveBeenCalledOnce()
    })
  })

  describe("GET /api/v1/conversations/:conversationId", () => {
    it("responds with the conversation, its transcript with every reply part, and its sources read from history", async () => {
      /**
       * Complete transcript of {@link CONVERSATION_ID} returned by the stubbed
       * history.
       */
      const conversation = Object.freeze({
        ...CONVERSATION_METADATA,
        messages: [
          createUserMessage(2, "Plan my trip"),
          createAssistantMessage(
            3,
            [
              createReasoningPart(4, 0, "They want a plan."),
              createToolCallPart(
                {
                  sequence: 5,
                  round: 0,
                  toolName: "web_search",
                  argumentText: '{"query":"trip"}'
                },
                { status: "succeeded", result: "Results", sourceNumbers: [1] }
              ),
              createTextPart({
                sequence: 6,
                round: 1,
                content: "Here is a plan [1]"
              })
            ],
            { status: "completed", finishReason: "stop" }
          )
        ],
        sources: [{ number: 1, url: "https://trips.example/", title: "Trips" }],
        jobs: []
      } satisfies Conversation)

      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockReturnValue(conversation)

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(conversation)
      expect(historyCalls.getConversation).toHaveBeenCalledWith(CONVERSATION_ID)
    })

    it("still reads a job with GET", async () => {
      /**
       * Complete transcript of {@link JOB_ID} returned by the stubbed history:
       * its delegator's message and one completed reply.
       */
      const job = Object.freeze({
        ...JOB_METADATA,
        messages: [
          {
            ...createUserMessage(8, "Find what moths eat"),
            origin: "delegator"
          },
          createAssistantMessage(
            9,
            [
              createTextPart({
                sequence: 10,
                round: 0,
                content: "Mostly nectar."
              })
            ],
            { status: "completed", finishReason: "stop" }
          )
        ],
        sources: [],
        jobs: []
      } satisfies Conversation)

      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockReturnValue(job)

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${JOB_ID}`
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(job)
    })

    it("responds with the missing-conversation problem", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockReturnValue(undefined)
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({ method: "GET", url })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationNotFoundProblemSchema.parse(response.json())
      ).toMatchObject({ instance: url })
      expect(historyCalls.getConversation).toHaveBeenCalledWith(
        MISSING_CONVERSATION_ID
      )
    })

    it("responds with a server error when the conversation cannot be read", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(500)
    })

    it("rejects an identifier that is not a UUIDv7", async () => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations/conversation-1"
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.getConversation).not.toHaveBeenCalled()
    })
  })

  describe("PATCH /api/v1/conversations/:conversationId", () => {
    it("replaces the title with its trimmed text and responds with the metadata", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.updateConversationTitle.mockReturnValue(
        CONVERSATION_METADATA
      )

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "  Trip plan  " }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(CONVERSATION_METADATA)
      expect(historyCalls.updateConversationTitle).toHaveBeenCalledWith(
        CONVERSATION_ID,
        "Trip plan"
      )
    })

    it("replaces the title of a conversation whose transcript cannot be read, because it reads only the metadata", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockImplementation(() => {
        throw new Error("The stored transcript is invalid")
      })
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.updateConversationTitle.mockReturnValue(
        CONVERSATION_METADATA
      )

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "Trip plan" }
      })

      expect(response.statusCode).toBe(200)
      expect(historyCalls.getConversationMetadata).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
      expect(historyCalls.getConversation).not.toHaveBeenCalled()
    })

    it("responds with the missing-conversation problem", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(undefined)
      historyCalls.updateConversationTitle.mockReturnValue(undefined)
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({
        method: "PATCH",
        url,
        payload: { title: "Trip plan" }
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationNotFoundProblemSchema.parse(response.json())
      ).toMatchObject({ instance: url })
    })

    it("answers 409 with the is-job problem when the title of a job is changed, and changes nothing", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(JOB_METADATA)
      const url = `/api/v1/conversations/${JOB_ID}`

      const response = await app.inject({
        method: "PATCH",
        url,
        payload: { title: "Moth food" }
      })

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationIsJobProblemSchema.parse(response.json())
      ).toMatchObject({
        type: "urn:lys:problem:conversation:is-job",
        instance: url
      })
      expect(historyCalls.getConversationMetadata).toHaveBeenCalledWith(JOB_ID)
      expect(historyCalls.updateConversationTitle).not.toHaveBeenCalled()
    })

    it("responds with a server error and replaces nothing when the conversation's metadata cannot be read", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "Trip plan" }
      })

      expect(response.statusCode).toBe(500)
      expect(historyCalls.updateConversationTitle).not.toHaveBeenCalled()
    })

    it("responds with a server error when the title cannot be replaced", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.updateConversationTitle.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "Trip plan" }
      })

      expect(response.statusCode).toBe(500)
    })

    it("rejects a blank title without replacing it", async () => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "   " }
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.updateConversationTitle).not.toHaveBeenCalled()
    })
  })

  describe("DELETE /api/v1/conversations/:conversationId", () => {
    it("deletes the conversation with its attachment files and responds without a body", async () => {
      const {
        app,
        historyCalls,
        attachmentFileStore,
        attachmentsDirectoryPath
      } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.deleteConversation.mockReturnValue(true)
      await attachmentFileStore.saveMessageAttachments(
        CONVERSATION_ID,
        createFixtureUuidV7(2),
        [{ name: "notes.md", content: new TextEncoder().encode("Notes") }]
      )
      const otherConversationId = createFixtureUuidV7(5)
      await attachmentFileStore.saveMessageAttachments(
        otherConversationId,
        createFixtureUuidV7(6),
        [{ name: "kept.md", content: new TextEncoder().encode("Kept") }]
      )

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(historyCalls.deleteConversation).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
      expect(existsSync(join(attachmentsDirectoryPath, CONVERSATION_ID))).toBe(
        false
      )
      expect(
        existsSync(join(attachmentsDirectoryPath, otherConversationId))
      ).toBe(true)
    })

    it("lists the working replies before the delete, and cancels them once it succeeded, before it removes the attachment files", async () => {
      const { app, historyCalls, deletionCalls, attachmentFileStore } =
        await createConversationRouteApp()
      const workingReplies: readonly ReplyTarget[] = [
        {
          conversationId: CONVERSATION_ID,
          assistantMessageId: createFixtureUuidV7(3)
        },
        { conversationId: JOB_ID, assistantMessageId: createFixtureUuidV7(9) }
      ]
      const steps: string[] = []
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      deletionCalls.listWorkingReplies.mockImplementation(() => {
        steps.push("list the working replies")
        return workingReplies
      })
      historyCalls.deleteConversation.mockImplementation(() => {
        steps.push("delete the rows")
        return true
      })
      deletionCalls.stopDeletedReplies.mockImplementation(async () => {
        steps.push("cancel the work")
        await waitForMicrotasks()
        steps.push("the work has ended")
      })
      vi.spyOn(
        attachmentFileStore,
        "deleteConversationAttachments"
      ).mockImplementation(() => {
        steps.push("remove the files")
        return Promise.resolve()
      })

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(204)
      expect(steps).toEqual([
        "list the working replies",
        "delete the rows",
        "cancel the work",
        "the work has ended",
        "remove the files"
      ])
      expect(deletionCalls.listWorkingReplies).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
      expect(deletionCalls.stopDeletedReplies).toHaveBeenCalledWith(
        CONVERSATION_ID,
        workingReplies
      )
    })

    it("deletes a main conversation, its jobs, and their reports, then cancels the replies that were working in them", async () => {
      /** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
      const lampsRequest: JobMessageRequest = Object.freeze({
        agentCode: SECOND_MEMBER,
        title: "Lamps",
        instructions: "Find which lamps draw moths",
        jobNumber: undefined
      })

      const { app, services } = await createDelegationRouteApp()
      const lead = startPersonTurn(services)
      const conversationId = lead.turn.conversation.id
      const finishedJob = sendJobMessage(services, lead, MOTHS_REQUEST)
      await services.resolveReply(finishedJob.replyId, "completed")
      const workingJob = sendJobMessage(services, lead, lampsRequest)
      const storedReports = listJobReportRows(services.conversation.database)

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${conversationId}`
      })

      expect(response.statusCode).toBe(204)
      expect(
        [conversationId, finishedJob.id, workingJob.id].map((id) =>
          services.conversation.history.getConversationMetadata(id)
        )
      ).toEqual([undefined, undefined, undefined])
      expect(storedReports).toEqual([
        expect.objectContaining({ jobId: finishedJob.id, kind: "result" })
      ])
      expect(listJobReportRows(services.conversation.database)).toEqual([])
      expect(
        [buildReplyTarget(lead), buildJobReplyTarget(workingJob)].map(
          (target) => services.generations.findReplyGeneration(target)
        )
      ).toEqual([undefined, undefined])
      expect(services.hub.removeReply).toHaveBeenCalledWith(
        lead.turn.assistantMessage.id,
        null
      )
      expect(services.hub.removeReply).toHaveBeenCalledWith(
        workingJob.replyId,
        null
      )
      expect(services.reportEvent).toHaveBeenCalledWith({
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 2
      })
    })

    it("aborts the reply request and the title request of a deleted conversation whose model holds its first piece, without the model sending anything", async () => {
      /** Chat request body that starts a new conversation Caliginia answers. */
      const newConversationChatRequest = Object.freeze({
        conversation: { kind: "new", agentCode: "caliginia" },
        message: "Plan my trip",
        model: "qwen/qwen3-8b",
        generationOptions: { temperature: 0.4 }
      })

      const testApp = await createHeldModelChatApp()
      const chatResponse = sendChatRequest(
        testApp.app,
        newConversationChatRequest
      )
      await vi.waitFor(() => {
        expect(testApp.completeChatStream).toHaveBeenCalledOnce()
        expect(testApp.generateTitle).toHaveBeenCalledOnce()
      })
      const conversationId = findOnlyConversationId(testApp.app)
      const replyRequestSignal =
        testApp.completeChatStream.mock.calls[0]?.[0].signal
      const titleRequestSignal = testApp.generateTitle.mock.calls[0]?.[0].signal

      const response = await testApp.app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${conversationId}`
      })

      expect(response.statusCode).toBe(204)
      expect(replyRequestSignal?.aborted).toBe(true)
      expect(titleRequestSignal?.aborted).toBe(true)
      const { body } = await chatResponse
      expect(parseSseEvents(body).map(({ event }) => event)).toEqual([
        "start-new-conversation-turn",
        "interrupted"
      ])
      expect(
        testApp.app.conversationHistoryReader.getConversationMetadata(
          conversationId
        )
      ).toBeUndefined()
    })

    it("leaves every generation running when the delete fails", async () => {
      const { app, services } = await createDelegationRouteApp()
      const lead = createPersonTurn(services.conversation.turns)
      const conversationId = lead.turn.conversation.id
      const replyTask = new ControlledReplyTask()
      const titleTask = new ControlledReplyTask()
      services.generations.startReplyGeneration(buildReplyTarget(lead), {
        startReplyTask: (context) => replyTask.start(context),
        startTitleTask: (context) => titleTask.start(context),
        reportTaskFailure: vi.fn()
      })
      onTestFinished(() => {
        replyTask.resolve()
        titleTask.resolve()
      })
      const job = sendJobMessage(services, lead, MOTHS_REQUEST)
      await waitForMicrotasks()
      vi.spyOn(
        services.conversation.editor,
        "deleteConversation"
      ).mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${conversationId}`
      })

      expect(response.statusCode).toBe(500)
      expect(replyTask.context.abortSignal.aborted).toBe(false)
      expect(titleTask.context.abortSignal.aborted).toBe(false)
      expect(
        services.generations.findReplyGeneration(buildJobReplyTarget(job))
      ).toBeDefined()
      expect(
        services.runtime.wakeSettings.findWakeSettings(conversationId)
      ).toMatchObject({ status: "found" })
      expect(services.reportEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stop-requested" })
      )
    })

    it("answers 404 and stops nothing for a conversation that is not stored", async () => {
      const { app, services } = await createDelegationRouteApp()
      const lead = startPersonTurn(services)
      const job = sendJobMessage(services, lead, MOTHS_REQUEST)
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({ method: "DELETE", url })

      expect(response.statusCode).toBe(404)
      expect(
        conversationNotFoundProblemSchema.parse(response.json())
      ).toMatchObject({ instance: url })
      expect(
        [buildReplyTarget(lead), buildJobReplyTarget(job)].map((target) =>
          services.generations.findReplyGeneration(target)
        )
      ).toEqual([expect.anything(), expect.anything()])
      expect(services.reportEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stop-requested" })
      )
    })

    it("deletes a conversation whose transcript cannot be read, because it reads only the metadata", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockImplementation(() => {
        throw new Error("The stored transcript is invalid")
      })
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.deleteConversation.mockReturnValue(true)

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(204)
      expect(historyCalls.getConversationMetadata).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
      expect(historyCalls.deleteConversation).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
      expect(historyCalls.getConversation).not.toHaveBeenCalled()
    })

    it("still responds without a body, logging the failure with its cause, when the attachment files cannot be removed", async () => {
      const { app, log, historyCalls, attachmentFileStore } =
        await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.deleteConversation.mockReturnValue(true)
      const removalFailure = new Error("EACCES: permission denied")
      vi.spyOn(
        attachmentFileStore,
        "deleteConversationAttachments"
      ).mockRejectedValue(removalFailure)

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(204)
      expect(log.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "The deleted conversation's attachment files could not be removed",
          err: expect.objectContaining({ message: removalFailure.message })
        })
      )
    })

    it("responds with the missing-conversation problem without touching the attachment files", async () => {
      const { app, historyCalls, attachmentFileStore } =
        await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(undefined)
      historyCalls.deleteConversation.mockReturnValue(false)
      const deleteConversationAttachments = vi.spyOn(
        attachmentFileStore,
        "deleteConversationAttachments"
      )
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({ method: "DELETE", url })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationNotFoundProblemSchema.parse(response.json())
      ).toMatchObject({ instance: url })
      expect(deleteConversationAttachments).not.toHaveBeenCalled()
    })

    it("answers 409 with the is-job problem when a job is deleted, and deletes nothing", async () => {
      const { app, historyCalls, deletionCalls, attachmentFileStore } =
        await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(JOB_METADATA)
      const deleteConversationAttachments = vi.spyOn(
        attachmentFileStore,
        "deleteConversationAttachments"
      )
      const url = `/api/v1/conversations/${JOB_ID}`

      const response = await app.inject({ method: "DELETE", url })

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationIsJobProblemSchema.parse(response.json())
      ).toMatchObject({
        type: "urn:lys:problem:conversation:is-job",
        instance: url
      })
      expect(historyCalls.getConversationMetadata).toHaveBeenCalledWith(JOB_ID)
      expect(historyCalls.deleteConversation).not.toHaveBeenCalled()
      expect(deletionCalls.stopDeletedReplies).not.toHaveBeenCalled()
      expect(deleteConversationAttachments).not.toHaveBeenCalled()
    })

    it("responds with a server error and deletes nothing when the conversation's metadata cannot be read", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(500)
      expect(historyCalls.deleteConversation).not.toHaveBeenCalled()
    })

    it("responds with a server error when the conversation cannot be deleted", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversationMetadata.mockReturnValue(
        CONVERSATION_METADATA
      )
      historyCalls.deleteConversation.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(500)
    })
  })
})
