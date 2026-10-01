import { APIUserAbortError, BadRequestError } from "openai"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import ChatService, {
  type ChatServiceCreationOptions
} from "../../../../src/di/services/chatService"
import {
  ChatCompletionCancelledError,
  TitleGenerationOutputError
} from "../../../../src/utils/errors"
import {
  createChatCompletion,
  createChatCompletionChunk,
  createChatCompletionResponse,
  createChatCompletionStreamResponse,
  createOpenAiErrorResponse,
  installOpenAiEndpointFake,
  type OpenAiEndpointResponder
} from "../../support/openAiEndpointFake"

/** Endpoint base URL used by every service in these cases. */
const OPENAI_BASE_URL = "http://lmstudio.test/v1"

/** Creation options shared by the cases; each case varies only what it tests. */
const SERVICE_OPTIONS = Object.freeze({
  openAiBaseUrl: OPENAI_BASE_URL,
  titleGenerationPrompt: "Summarize the message as a short title.",
  generatedTitleMaxLength: 12
} satisfies ChatServiceCreationOptions)

/**
 * Installs the endpoint fake and creates a service that sends requests to it.
 *
 * @param respond - Endpoint behavior for the case.
 * @param options - Service options overriding {@link SERVICE_OPTIONS}.
 * @returns The service and the endpoint's request log.
 */
function createServiceWithEndpoint(
  respond: OpenAiEndpointResponder,
  options: Partial<ChatServiceCreationOptions> = {}
) {
  const endpoint = installOpenAiEndpointFake(respond)
  const service = new ChatService({ ...SERVICE_OPTIONS, ...options })
  return { service, endpoint }
}

/**
 * Creates a service whose title request receives one reply content.
 *
 * @param content - Reply content, or null for a reply without text.
 * @param finishReason - Reason the title reply stopped.
 * @returns The service.
 */
function createServiceReplyingWithTitle(
  content: string | null,
  finishReason: Parameters<typeof createChatCompletion>[1] = "stop"
) {
  return createServiceWithEndpoint(() =>
    createChatCompletionResponse(createChatCompletion(content, finishReason))
  ).service
}

/**
 * Collects every chunk of a completion stream.
 *
 * @param stream - Stream returned by the service.
 * @returns The chunks in stream order.
 */
async function collectChunks<Chunk>(
  stream: AsyncIterable<Chunk>
): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

describe("ChatService", () => {
  describe("completeChatStream", () => {
    it("requests a streamed completion with the messages, model, and generation options", async () => {
      const { service, endpoint } = createServiceWithEndpoint(() =>
        createChatCompletionStreamResponse([])
      )

      await collectChunks(
        await service.completeChatStream({
          messages: [
            { role: "system", content: "You are Lys." },
            { role: "user", content: "Hello" }
          ],
          model: "qwen/qwen3-8b",
          generationOptions: { temperature: 0.4, replyCeiling: 256 }
        })
      )

      expect(endpoint.requests).toHaveLength(1)
      expect(endpoint.requests[0]).toMatchObject({
        url: `${OPENAI_BASE_URL}/chat/completions`,
        method: "POST",
        body: {
          messages: [
            { role: "system", content: "You are Lys." },
            { role: "user", content: "Hello" }
          ],
          model: "qwen/qwen3-8b",
          stream: true,
          temperature: 0.4,
          max_completion_tokens: 256
        }
      })
    })

    it("sends no completion-length limit when the reply ceiling is omitted", async () => {
      const { service, endpoint } = createServiceWithEndpoint(() =>
        createChatCompletionStreamResponse([])
      )

      await collectChunks(
        await service.completeChatStream({
          messages: [{ role: "user", content: "Hello" }],
          model: "qwen/qwen3-8b",
          generationOptions: { temperature: 0 }
        })
      )

      expect(endpoint.requests[0]?.body).toMatchObject({
        temperature: 0,
        max_completion_tokens: null
      })
    })

    it("yields the endpoint's chunks in stream order", async () => {
      const chunks = [
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ content: " there" }),
        createChatCompletionChunk({ finishReason: "stop" })
      ]
      const { service } = createServiceWithEndpoint(() =>
        createChatCompletionStreamResponse(chunks)
      )

      const received = await collectChunks(
        await service.completeChatStream({
          messages: [{ role: "user", content: "Hello" }],
          model: "qwen/qwen3-8b",
          generationOptions: { temperature: 0.4 }
        })
      )

      expect(received).toEqual(chunks)
    })

    it("authenticates with the placeholder credential unless a key is configured", async () => {
      const { service, endpoint } = createServiceWithEndpoint(() =>
        createChatCompletionStreamResponse([])
      )
      const keyed = new ChatService({ ...SERVICE_OPTIONS, apiKey: "local-key" })

      for (const client of [service, keyed]) {
        await collectChunks(
          await client.completeChatStream({
            messages: [{ role: "user", content: "Hello" }],
            model: "qwen/qwen3-8b",
            generationOptions: { temperature: 0.4 }
          })
        )
      }

      const [placeholder, configured] = endpoint.requests.map(({ headers }) =>
        headers.get("authorization")
      )
      expect(placeholder).toMatch(/^Bearer \S+$/)
      expect(configured).toBe("Bearer local-key")
    })

    it("reports cancellation of a pending request as a cancelled completion", async () => {
      const cancellation = new AbortController()
      const { service } = createServiceWithEndpoint(async () => {
        cancellation.abort()
        return await new Promise<Response>(() => undefined)
      })

      const failure = await service
        .completeChatStream({
          messages: [{ role: "user", content: "Hello" }],
          model: "qwen/qwen3-8b",
          signal: cancellation.signal,
          generationOptions: { temperature: 0.4 }
        })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(ChatCompletionCancelledError)
      expect(failure).toMatchObject({ cause: expect.any(APIUserAbortError) })
    })

    it("reports an already cancelled request as a cancelled completion without sending it", async () => {
      const { service, endpoint } = createServiceWithEndpoint(() =>
        createChatCompletionStreamResponse([])
      )

      await expect(
        service.completeChatStream({
          messages: [{ role: "user", content: "Hello" }],
          model: "qwen/qwen3-8b",
          signal: AbortSignal.abort(),
          generationOptions: { temperature: 0.4 }
        })
      ).rejects.toBeInstanceOf(ChatCompletionCancelledError)
      expect(endpoint.requests).toEqual([])
    })

    it("propagates an endpoint rejection unchanged", async () => {
      const { service } = createServiceWithEndpoint(() =>
        createOpenAiErrorResponse(400, "model not loaded")
      )

      const failure = await service
        .completeChatStream({
          messages: [{ role: "user", content: "Hello" }],
          model: "qwen/qwen3-8b",
          generationOptions: { temperature: 0.4 }
        })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(BadRequestError)
      expect(failure).not.toBeInstanceOf(ChatCompletionCancelledError)
    })
  })

  describe("generateTitle", () => {
    it("requests a schema-constrained title for the user message", async () => {
      const { service, endpoint } = createServiceWithEndpoint(() =>
        createChatCompletionResponse(createChatCompletion('{"title":"Trip"}'))
      )

      await service.generateTitle({
        message: "Plan my trip to Hanoi",
        model: "qwen/qwen3-8b"
      })

      expect(endpoint.requests[0]?.body).toMatchObject({
        messages: [
          { role: "system", content: SERVICE_OPTIONS.titleGenerationPrompt },
          { role: "user", content: "Plan my trip to Hanoi" }
        ],
        model: "qwen/qwen3-8b",
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              required: ["title"],
              properties: {
                title: {
                  type: "string",
                  maxLength: SERVICE_OPTIONS.generatedTitleMaxLength
                }
              }
            }
          }
        }
      })
    })

    it("returns the generated title without surrounding whitespace", async () => {
      const service = createServiceReplyingWithTitle('{"title":"  Trip  "}')

      await expect(
        service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
      ).resolves.toBe("Trip")
    })

    it.each([
      ["a json-tagged code fence", '```json\n{"title":"Trip"}\n```'],
      ["an untagged code fence", '```\n{"title":"Trip"}\n```'],
      [
        "a fence with surrounding whitespace",
        '  ```json\n{"title":"Trip"}\n```  '
      ]
    ])("accepts JSON wrapped in %s", async (_label, content) => {
      const service = createServiceReplyingWithTitle(content)

      await expect(
        service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
      ).resolves.toBe("Trip")
    })

    it("accepts a title at the limit counted in code points", async () => {
      const title = "🌏".repeat(SERVICE_OPTIONS.generatedTitleMaxLength)
      const service = createServiceReplyingWithTitle(JSON.stringify({ title }))

      await expect(
        service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
      ).resolves.toBe(title)
    })

    it("selects the choice at index 0", async () => {
      const completion = createChatCompletion('{"title":"Second"}')
      const [firstChoice] = completion.choices
      if (firstChoice === undefined) {
        throw new Error("Fixture completion has no choice")
      }
      completion.choices = [
        { ...firstChoice, index: 1 },
        {
          ...firstChoice,
          index: 0,
          message: { ...firstChoice.message, content: '{"title":"First"}' }
        }
      ]
      const { service } = createServiceWithEndpoint(() =>
        createChatCompletionResponse(completion)
      )

      await expect(
        service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
      ).resolves.toBe("First")
    })

    it.each([
      ["a reply truncated by length", '{"title":"Trip"}', "length"],
      ["a reply without text", null, "stop"],
      ["a blank title", '{"title":"   "}', "stop"]
    ] as const)(
      "rejects %s as unusable output",
      async (_label, content, finishReason) => {
        const service = createServiceReplyingWithTitle(content, finishReason)

        await expect(
          service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
        ).rejects.toBeInstanceOf(TitleGenerationOutputError)
      }
    )

    it("rejects a reply without a choice at index 0 as unusable output", async () => {
      const completion = createChatCompletion('{"title":"Trip"}')
      completion.choices = []
      const { service } = createServiceWithEndpoint(() =>
        createChatCompletionResponse(completion)
      )

      await expect(
        service.generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
      ).rejects.toBeInstanceOf(TitleGenerationOutputError)
    })

    it("rejects content that is not JSON and keeps the syntax error", async () => {
      const service = createServiceReplyingWithTitle("Trip to Hanoi")

      const failure = await service
        .generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(TitleGenerationOutputError)
      expect(failure).toMatchObject({ cause: expect.any(SyntaxError) })
    })

    it.each([
      ["a reply without a title", '{"name":"Trip"}'],
      ["a non-text title", '{"title":42}'],
      [
        "a title one code point over the limit",
        JSON.stringify({
          title: "🌏".repeat(SERVICE_OPTIONS.generatedTitleMaxLength + 1)
        })
      ]
    ])("rejects %s and keeps the validation error", async (_label, content) => {
      const service = createServiceReplyingWithTitle(content)

      const failure = await service
        .generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(TitleGenerationOutputError)
      expect(failure).toMatchObject({ cause: expect.any(z.ZodError) })
    })

    it("propagates an endpoint rejection without treating it as unusable output", async () => {
      const { service } = createServiceWithEndpoint(() =>
        createOpenAiErrorResponse(400, "response_format unsupported")
      )

      const failure = await service
        .generateTitle({ message: "Plan", model: "qwen/qwen3-8b" })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(BadRequestError)
      expect(failure).not.toBeInstanceOf(TitleGenerationOutputError)
    })

    it("propagates cancellation of a pending title request", async () => {
      const cancellation = new AbortController()
      const { service } = createServiceWithEndpoint(async () => {
        cancellation.abort()
        return await new Promise<Response>(() => undefined)
      })

      const failure = await service
        .generateTitle({
          message: "Plan",
          model: "qwen/qwen3-8b",
          signal: cancellation.signal
        })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(APIUserAbortError)
    })
  })

  it("completes disposal without releasing anything", async () => {
    const service = new ChatService(SERVICE_OPTIONS)

    await expect(service[Symbol.asyncDispose]()).resolves.toBeUndefined()
  })
})
