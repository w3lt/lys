import { OpenAI } from "openai"
import { ChatCompletionMessageParam } from "openai/resources/index.mjs"

export type ChatServiceCreationOptions = {
  openAiBaseUrl: string
  apiKey?: string
}

export type CompleteChatOptions = {
  messages: ChatCompletionMessageParam[]
  model: string
  stream?: boolean
  signal?: AbortSignal
}

const DUMMY_API_KEY = "dummy-api-key"

export default class ChatService {
  #openaiClient: OpenAI

  constructor({ openAiBaseUrl, apiKey }: ChatServiceCreationOptions) {
    this.#openaiClient = new OpenAI({
      baseURL: openAiBaseUrl,
      apiKey: apiKey ?? DUMMY_API_KEY
    })
  }

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

  public async [Symbol.asyncDispose]() {}
}
