import { BackendConfig } from "../config"
import ChatService from "./services/chatService"
import LlmService from "./services/llmService"

export type SingletonServices = Readonly<{
  chatService: ChatService
  llmService: LlmService
}>

export function createSingletonServices(
  config: BackendConfig
): SingletonServices {
  const chatService = new ChatService({
    openAiBaseUrl: `http://${config.lmstudioHost}:${config.lmstudioPort}/v1`
  })

  const llmService = new LlmService({
    lmsBaseUrl: `ws://${config.lmstudioHost}:${config.lmstudioPort}`
  })

  return {
    chatService,
    llmService
  }
}

export async function disposeSingletonServices(
  services: SingletonServices
): Promise<void> {
  await services.chatService[Symbol.asyncDispose]()
  await services.llmService[Symbol.asyncDispose]()
}
