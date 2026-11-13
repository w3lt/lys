import fastifyPlugin from "fastify-plugin"
import { type FastifyInstance, type FastifyPluginAsync } from "fastify"
import type { BackendConfig } from "../config"
import { handleDelegationEvent } from "../modules/delegation/delegationEventLog"
import type { LlmRuntimeFailureReporters } from "../modules/llm/llmRuntimeService"
import PinoLmStudioSdkLogger from "../modules/llm/runtimes/pinoLmStudioSdkLogger"
import { handleEmailAccountCheckEvent } from "../modules/mcp/builtIn/email/emailAccountCheckLog"
import { handleMcpServerEvent } from "../modules/mcp/mcpServerEventLog"
import type { PageRenderingFailureReporters } from "../modules/tool/builtIn/web/pageRendering"
import {
  closeSingletonServices,
  createSingletonServices,
  type SingletonServices
} from "./singleton"

/** Options used to open the application-scoped singleton services. */
type SingletonServicePluginOptions = {
  /** Runtime configuration used to construct the singleton services. */
  config: BackendConfig
}

/**
 * Opens the application-scoped services and connects their disposal to Fastify shutdown.
 *
 * @param app - Fastify application that receives the service decorations and close hook.
 * @param options - Configuration used to construct the singleton services.
 * @returns A promise that resolves after the services are open and the shutdown hook is registered.
 * @throws If service construction or Fastify decoration and hook registration fails.
 * @remarks The services are exposed as Fastify decorations and disposed when
 * Fastify closes. The activity hub is closed first, then the reply
 * generation registry is disposed, both in `preClose`, while SSE streams
 * are still open: every activity stream ends, then every generation stores
 * its final state and its followers end, before the server waits for
 * requests and before the services close SQLite. After the HTTP listener
 * opens, an `onListen` hook performs
 * the first LLM runtime connection attempt. Fastify resolves `listen()` before
 * running the hook and logs a hook rejection, so the provider never delays or
 * prevents listening. `inject()` and `ready()` do not run the hook. An
 * `onReady` hook applies the MCP settings before the backend listens, so the
 * first request already sees every configured server, connecting; the
 * servers connect in the background and never delay listening. The
 * services' failures that no caller observes, the messages of the LM
 * Studio SDK, the MCP servers' events, the email account checks, the
 * failures to save their process groups file, delegation's events, and the
 * turns the backend starts itself are logged through the application's
 * logger.
 */
const openSingletonServices: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const llmRuntime: LlmRuntimeFailureReporters = {
    reportLlmRuntimeAcquisitionFailure: (failure) => {
      app.log.warn(
        { err: failure },
        "Model provider runtime acquisition failed"
      )
    },
    reportLlmRuntimeAvailabilityCheckFailure: (failure) => {
      app.log.error(
        { err: failure },
        "Model provider runtime check or release failed after a model operation"
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
  const lmStudioSdk = new PinoLmStudioSdkLogger(app.log)
  const singletonServices = await createSingletonServices(config, {
    llmRuntime,
    pageRendering,
    lmStudioSdk,
    reportMcpServerEvent: (event) => {
      handleMcpServerEvent(app.log, event)
    },
    reportMcpProcessGroupsSaveFailure: (failure) => {
      app.log.error(
        { err: failure },
        "The MCP servers' process groups file could not be saved; if the backend is killed, the desktop may not end every MCP server"
      )
    },
    sendEmailAccountCheckEvent: (event) => {
      handleEmailAccountCheckEvent(app.log, event)
    },
    reportDelegationEvent: (event) => {
      handleDelegationEvent(app.log, event)
    },
    backendTurnLogger: app.log
  })

  app.addHook("preClose", async () => {
    singletonServices.activityHub.close()
    await singletonServices.replyGenerations[Symbol.asyncDispose]()
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
  app.decorate(
    "mcpServerProcessGroups",
    singletonServices.mcpServerProcessGroups
  )
  app.decorate("emailAccountChecker", singletonServices.emailAccountChecker)
  app.decorate("attachmentFileStore", singletonServices.attachmentFileStore)
  app.decorate("replyGenerations", singletonServices.replyGenerations)
  app.decorate("startTurn", singletonServices.startTurn)
  app.decorate("activityHub", singletonServices.activityHub)
  app.decorate("turnDelegations", singletonServices.turnDelegations)
}

/** Fastify plugin that opens the application-scoped singleton services. */
export default fastifyPlugin(openSingletonServices, {
  name: "singleton-services"
})
