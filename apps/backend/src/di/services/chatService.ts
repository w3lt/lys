import { OpenAI } from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs"
import * as z from "zod"
import { titleGenerationPrompt } from "../../utils/prompts"
import { zodTextFormat } from "openai/helpers/zod"
import type { MessageGenerationOptions } from "@lys/protocol"

/** Settings used to create an application-scoped OpenAI-compatible chat client. */
export type ChatServiceCreationOptions = {
  /** Base URL of the OpenAI-compatible chat completion endpoint. */
  openAiBaseUrl: string
  /**
   * Optional endpoint credential.
   *
   * @remarks Defaults to a non-secret placeholder because local OpenAI-compatible servers require a value but may not authenticate it.
   */
  apiKey?: string
}

/** Inputs shared by chat completion requests. */
export type CompleteChatOptions = {
  /** Ordered conversation messages sent to the configured model. */
  messages: ChatCompletionMessageParam[]
  /** Identifier of the model that should generate the completion. */
  model: string
  /**
   * Whether the caller requested streaming in the shared option shape.
   *
   * @remarks {@link ChatService["completeChatStream"]} always requests streaming.
   */
  stream?: boolean
  /** Abort signal that cancels the in-flight completion request. */
  signal?: AbortSignal
  /** Sampling and completion-length controls forwarded to the model request. */
  generationOptions: MessageGenerationOptions
}

/** Inputs used to generate a structured conversation title from one user message. */
export type TitleGenerationOptions = {
  /** User-authored message supplied as the title-generation input. */
  message: string
  /** Identifier of the model that generates the title. */
  model: string
  /** Optional signal that cancels the title-generation request. */
  signal?: AbortSignal
}

/** Validates the structured title returned by the model response parser. */
const titleGenerationOutputSchema = z.object({
  /** Generated title before the service trims and validates non-emptiness. */
  title: z.string()
})

/** Fallback credential value for unauthenticated OpenAI-compatible local endpoints. */
const DUMMY_API_KEY = "dummy-api-key"

/**
 * Owns an OpenAI client that adapts chat and title generation to the backend's
 * OpenAI-compatible local endpoint.
 *
 * @remarks The instance
 * owns its SDK client for its application lifetime; request inputs are borrowed
 * and cancellation is owned by each caller. Concurrency model: reentrant at
 * this service boundary; no request-local mutable state is retained and
 * request concurrency is delegated to the SDK.
 */
export default class ChatService {
  /** Owned OpenAI SDK client used to create chat completions. */
  #openaiClient: OpenAI

  /**
   * Creates a chat completion adapter for an endpoint and optional credential.
   *
   * @param options - Endpoint and optional credential used to create the client.
   */
  constructor({ openAiBaseUrl, apiKey }: ChatServiceCreationOptions) {
    this.#openaiClient = new OpenAI({
      baseURL: openAiBaseUrl,
      apiKey: apiKey ?? DUMMY_API_KEY
    })
  }

  /**
   * Starts a streamed chat completion against the configured endpoint.
   *
   * @param options - Messages, model selection, and optional cancellation signal for the request.
   * @returns A promise that resolves to the asynchronous stream of chat completion chunks after the request is established.
   * @throws If the request is rejected, aborted, or cannot be streamed by the configured endpoint.
   */
  public async completeChatStream({
    messages,
    model,
    signal,
    generationOptions
  }: CompleteChatOptions) {
    const { temperature, replyCeiling } = generationOptions
    return await this.#openaiClient.chat.completions.create(
      {
        messages,
        model,
        stream: true,
        temperature,
        max_completion_tokens: replyCeiling ?? null
      },
      { signal }
    )
  }

  /**
   * Generates and validates one non-empty title from a user message.
   *
   * @param options - Message, model, and optional cancellation signal for the request.
   * @returns A promise that resolves to the trimmed generated title after structured response parsing.
   * @throws If the request is rejected, cancelled, malformed, or produces no non-empty title.
   */
  public async generateTitle({
    message,
    model,
    signal
  }: TitleGenerationOptions): Promise<string> {
    const response = await this.#openaiClient.responses.parse(
      {
        model,
        instructions: titleGenerationPrompt(),
        input: message,

        reasoning: {
          effort: "high"
        },

        text: {
          format: zodTextFormat(titleGenerationOutputSchema, "title_generation")
        },

        store: false,
        stream: false
      },
      { signal }
    )

    const title = response.output_parsed?.title.trim()

    if (!title) {
      throw new Error("The model did not generate a title")
    }

    return title
  }

  /**
   * Completes asynchronous disposal of this adapter.
   *
   * @returns A promise that resolves immediately.
   * @remarks The current OpenAI client exposes no asynchronous cleanup requirement.
   */
  public async [Symbol.asyncDispose]() {}
}
