import fastifyPlugin from "fastify-plugin"
import { type FastifyPluginAsync } from "fastify"
import type { BackendConfig } from "../config"
import { closeSingletonServices, createSingletonServices } from "./singleton"

/** Options used to install application-scoped singleton services. */
type SingletonServicePluginOptions = {
  /** Runtime configuration used to construct the singleton services. */
  config: BackendConfig
}

/**
 * Installs application-scoped services and connects their disposal to Fastify shutdown.
 *
 * @param app - Fastify application that receives the service decorations and close hook.
 * @param options - Configuration used to construct the singleton services.
 * @returns A promise that resolves after the services and shutdown hook are installed.
 * @throws If service construction or Fastify decoration and hook registration fails.
 * @remarks The services are exposed as Fastify decorations and disposed when
 * Fastify closes. After the HTTP listener opens, an `onListen` hook performs
 * the first LLM runtime connection attempt. Fastify resolves `listen()` before
 * running the hook and logs a hook rejection, so LM Studio never delays or
 * prevents listening. `inject()` and `ready()` do not run the hook.
 */
const singletonPlugin: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const singletonServices = await createSingletonServices(config, {
    reportLlmRuntimeAcquisitionFailure: (failure) => {
      app.log.warn({ err: failure }, "LM Studio runtime acquisition failed")
    },
    reportLlmRuntimeAvailabilityCheckFailure: (failure) => {
      app.log.error(
        { err: failure },
        "LM Studio runtime check or release failed after a model operation"
      )
    }
  })

  app.addHook("onClose", async () => {
    await closeSingletonServices(singletonServices)
  })
  app.addHook("onListen", async () => {
    await singletonServices.llmRuntimeService.connectLlmRuntime()
  })

  app.decorate("chatService", singletonServices.chatService)
  app.decorate("llmService", singletonServices.llmService)
  app.decorate("llmRuntimeService", singletonServices.llmRuntimeService)
  app.decorate("conversationTurns", singletonServices.conversationTurns)
  app.decorate(
    "conversationHistoryReader",
    singletonServices.conversationHistoryReader
  )
  app.decorate(
    "conversationHistoryEditor",
    singletonServices.conversationHistoryEditor
  )
  app.decorate("agents", singletonServices.agents)
}

/** Fastify plugin that installs application-scoped singleton services. */
export default fastifyPlugin(singletonPlugin, {
  name: "singleton-services"
})
