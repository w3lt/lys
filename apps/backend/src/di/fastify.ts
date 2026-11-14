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
 * Fastify closes. In `preClose`, while SSE streams are still open, the
 * turns' activity is closed as {@link closeTurnActivity} closes it: no
 * wake-up turn starts any more, every activity stream ends, then every
 * generation stores its final state and its followers end, before the
 * server waits for requests and before the services close SQLite. After
 * the HTTP listener opens, an `onListen` hook performs
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
    await closeTurnActivity(singletonServices)
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
 * Closes what the running turns do while the backend shuts down, in the
 * order that keeps a reply that ends during the shutdown from starting a
 * wake-up turn.
 *
 * @param services - The wake settings, the activity hub, and the reply
 * generation registry the plugin created; the bundle's cleanup releases
 * them again later, which changes nothing.
 * @returns A promise that resolves once every running generation stored its
 * final state; it never rejects.
 * @remarks Closes the wake settings first, so a reply that ends while the
 * generations end starts no wake-up turn; then disposes of the activity
 * hub, which ends every activity stream; then disposes the registry, which
 * ends every generation.
 */
async function closeTurnActivity(
  services: Pick<
    SingletonServices,
    "conversationWakeSettings" | "activityHub" | "replyGenerations"
  >
): Promise<void> {
  services.conversationWakeSettings.close()
  services.activityHub[Symbol.dispose]()
  await services.replyGenerations[Symbol.asyncDispose]()
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
  app.decorate("handleTurnStarted", singletonServices.handleTurnStarted)
  app.decorate("createTurnDelegation", singletonServices.createTurnDelegation)
  app.decorate("handleReplyEnded", singletonServices.handleReplyEnded)
  app.decorate("stopReply", singletonServices.stopReply)
  app.decorate("stopConversationJobs", singletonServices.stopConversationJobs)
  app.decorate("listWorkingReplies", singletonServices.listWorkingReplies)
  app.decorate("stopDeletedReplies", singletonServices.stopDeletedReplies)
}

/** Fastify plugin that opens the application-scoped singleton services. */
export default fastifyPlugin(openSingletonServices, {
  name: "singleton-services"
})
