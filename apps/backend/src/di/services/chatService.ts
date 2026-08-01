import { OpenAI } from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs"
import * as z from "zod"
import { titleGenerationPrompt } from "../../utils/prompts"
import { zodTextFormat } from "openai/helpers/zod"

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
   * @remarks {@link ChatService.completeChatStream} always requests streaming.
   */
  stream?: boolean
  /** Abort signal that cancels the in-flight completion request. */
  signal?: AbortSignal
}

export type TitleGenerationOptions = {
  message: string
  model: string
  signal?: AbortSignal
}

const titleGenerationOutputSchema = z.object({
  title: z.string()
})

/** Fallback credential value for unauthenticated OpenAI-compatible local endpoints. */
const DUMMY_API_KEY = "dummy-api-key"

/** Application-scoped adapter around an OpenAI-compatible chat completion endpoint. */
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
    signal
  }: CompleteChatOptions) {
    return await this.#openaiClient.chat.completions.create(
      {
        messages,
        model,
        stream: true
      },
      { signal }
    )
  }

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
