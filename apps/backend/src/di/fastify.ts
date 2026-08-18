import fastifyPlugin from "fastify-plugin"
import { type FastifyPluginAsync } from "fastify"
import type { BackendConfig } from "../config"
import { createSingletonServices, disposeSingletonServices } from "./singleton"

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
 * @remarks The services are exposed as Fastify decorations and disposed when Fastify closes.
 */
const singletonPlugin: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const singletonServices = createSingletonServices(config)

  app.decorate("chatService", singletonServices.chatService)
  app.decorate("llmService", singletonServices.llmService)
  app.decorate("conversationService", singletonServices.conversationService)

  app.addHook("onClose", async () => {
    await disposeSingletonServices(singletonServices)
  })
}

/** Fastify plugin that installs application-scoped singleton services. */
export default fastifyPlugin(singletonPlugin, {
  name: "singleton-services"
})
