import fastifyPlugin from "fastify-plugin"
import { type FastifyInstance, type FastifyPluginAsync } from "fastify"
import type { BackendConfig } from "../config"
import type { LlmRuntimeFailureReporters } from "../modules/llm/llmRuntimeService"
import PinoLmStudioSdkLogger from "../modules/llm/runtimes/pinoLmStudioSdkLogger"
import { handleMcpServerEvent } from "../modules/mcp/mcpServerEventLog"
import type { PageRenderingFailureReporters } from "../modules/tool/builtIn/web/pageRendering"
import {
  closeSingletonServices,
  createSingletonServices,
  type SingletonServices
} from "./singleton"

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
 * prevents listening. `inject()` and `ready()` do not run the hook. An
 * `onReady` hook applies the MCP settings before the backend listens, so the
 * first request already sees every configured server, connecting; the
 * servers connect in the background and never delay listening. The
 * services' failures that no caller observes, the messages of the LM
 * Studio SDK, and the MCP servers' events are logged through the
 * application's logger.
 */
const singletonPlugin: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const llmRuntime: LlmRuntimeFailureReporters = {
    reportLlmRuntimeAcquisitionFailure: (failure) => {
      app.log.warn({ err: failure }, "LM Studio runtime acquisition failed")
    },
    reportLlmRuntimeAvailabilityCheckFailure: (failure) => {
      app.log.error(
        { err: failure },
        "LM Studio runtime check or release failed after a model operation"
      )
    }
  }
  const pageRendering: PageRenderingFailureReporters = {
    reportPageReaderFailure: (failure) => {
      app.log.error(
        { err: failure },
        "read_page's reader, vmo, could not be reached, failed, or did not answer in time"
      )
    }
  }
  const singletonServices = await createSingletonServices(config, {
    llmRuntime,
    pageRendering,
    lmStudioSdk: new PinoLmStudioSdkLogger(app.log),
    reportMcpServerEvent: (event) => {
      handleMcpServerEvent(app.log, event)
    }
  })

  app.addHook("onClose", async () => {
    await closeSingletonServices(singletonServices)
  })
  app.addHook("onListen", async () => {
    await singletonServices.llmRuntimeService.connectLlmRuntime()
  })
  app.addHook("onReady", async () => {
    await singletonServices.mcpServerRegistry.updateServers()
  })

  registerSingletonServices(app, singletonServices)
}

/**
 * Registers every singleton service with the application, so routes reach
 * them as `app.<service>`.
 *
 * @param app - Application the plugin runs in.
 * @param singletonServices - Services the plugin created; the application
 * borrows them until it closes.
 */
function registerSingletonServices(
  app: FastifyInstance,
  singletonServices: SingletonServices
): void {
  app.decorate("chatService", singletonServices.chatService)
  app.decorate("llmService", singletonServices.llmService)
  app.decorate("llmRuntimeService", singletonServices.llmRuntimeService)
  app.decorate("conversationTurns", singletonServices.conversationTurns)
  app.decorate("replyParts", singletonServices.replyParts)
  app.decorate(
    "conversationHistoryReader",
    singletonServices.conversationHistoryReader
  )
  app.decorate(
    "conversationHistoryEditor",
    singletonServices.conversationHistoryEditor
  )
  app.decorate("agentService", singletonServices.agentService)
  app.decorate("agentRuntimeService", singletonServices.agentRuntimeService)
  app.decorate("builtInTools", singletonServices.builtInTools)
  app.decorate("webSearchToolProvider", singletonServices.webSearchToolProvider)
  app.decorate("toolApprovalService", singletonServices.toolApprovalService)
  app.decorate("mcpServerRegistry", singletonServices.mcpServerRegistry)
  app.decorate("attachmentFileStore", singletonServices.attachmentFileStore)
}

/** Fastify plugin that installs application-scoped singleton services. */
export default fastifyPlugin(singletonPlugin, {
  name: "singleton-services"
})
