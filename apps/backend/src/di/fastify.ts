import fastifyPlugin from "fastify-plugin"
import { type FastifyPluginAsync } from "fastify"
import { BackendConfig } from "../config"
import { createSingletonServices, disposeSingletonServices } from "./singleton"

type SingletonServicePluginOptions = {
  config: BackendConfig
}

const singletonPlugin: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const singletonServices = createSingletonServices(config)

  app.decorate("chatService", singletonServices.chatService)
  app.decorate("llmSerivce", singletonServices.llmService)

  app.addHook("onClose", async () => {
    await disposeSingletonServices(singletonServices)
  })
}

export default fastifyPlugin(singletonPlugin, {
  name: "singleton-services"
})
