import fastifyPlugin from "fastify-plugin"
import {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginAsync
} from "fastify"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import type { BackendConfig } from "../config"
import {
  buildLlmProviderRecord,
  type LlmProviderRecord,
  type LlmProviderServices
} from "../modules/llm/llmProviderServices"
import type { LlmRuntimeConnector } from "../modules/llm/llmRuntimeCapabilities"
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
 * Fastify closes. After the HTTP listener opens, an `onListen` hook starts
 * the first LLM runtime connection attempt of every provider at once; each
 * attempt's failure is logged with its provider and never stops another's.
 * Fastify resolves `listen()` before running the hook, so no provider ever
 * delays or prevents listening. `inject()` and `ready()` do not run the
 * hook. An
 * `onReady` hook applies the MCP settings before the backend listens, so the
 * first request already sees every configured server, connecting; the
 * servers connect in the background and never delay listening. The
 * services' failures that no caller observes, each runtime failure with its
 * provider, the messages of the LM
 * Studio SDK, the MCP servers' events, the email account checks, and the
 * failures to save their process groups file are logged through the
 * application's logger.
 */
const openSingletonServices: FastifyPluginAsync<
  SingletonServicePluginOptions
> = async (app, { config }) => {
  const llmRuntime = buildLlmProviderRecord((provider) =>
    buildLlmRuntimeFailureReporters(app.log, provider)
  )
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
    },
    reportMcpProcessGroupsSaveFailure: (failure) => {
      app.log.error(
        { err: failure },
        "The MCP servers' process groups file could not be saved; if the backend is killed, the desktop may not end every MCP server"
      )
    },
    sendEmailAccountCheckEvent: (event) => {
      handleEmailAccountCheckEvent(app.log, event)
    }
  })

  app.addHook("onClose", async () => {
    await closeSingletonServices(singletonServices)
  })
  app.addHook("onListen", async () => {
    await connectLlmProviderRuntimes(
      app.log,
      singletonServices.llmProviderServices
    )
  })
  app.addHook("onReady", async () => {
    await singletonServices.mcpServerRegistry.updateServers()
  })

  registerSingletonServices(app, singletonServices)
}

/**
 * Builds the reporters of one provider's runtime failures that no caller
 * observes.
 *
 * @param log - Application logger the failures are written to.
 * @param provider - Provider whose failures the reporters receive; written
 * with each failure.
 * @returns Reporters that log an acquisition failure as a warning and a
 * failed check or release after a model operation as an error.
 */
function buildLlmRuntimeFailureReporters(
  log: FastifyBaseLogger,
  provider: LlmProvider
): LlmRuntimeFailureReporters {
  return {
    reportLlmRuntimeAcquisitionFailure: (failure) => {
      log.warn(
        { provider, err: failure },
        "Model provider runtime acquisition failed"
      )
    },
    reportLlmRuntimeAvailabilityCheckFailure: (failure) => {
      log.error(
        { provider, err: failure },
        "Model provider runtime check or release failed after a model operation"
      )
    }
  }
}

/**
 * Starts a connection attempt of every provider's runtime at once.
 *
 * @param log - Application logger each failed attempt is written to.
 * @param llmProviderServices - Each provider's runtime service.
 * @returns A promise that resolves once every attempt settled; it never
 * rejects.
 * @remarks One provider's failed attempt never stops another's.
 */
async function connectLlmProviderRuntimes(
  log: FastifyBaseLogger,
  llmProviderServices: LlmProviderRecord<LlmProviderServices>
): Promise<void> {
  await Promise.all(
    LLM_PROVIDERS.map((provider) =>
      connectLlmProviderRuntime(
        log,
        provider,
        llmProviderServices[provider].llmRuntimeService
      )
    )
  )
}

/**
 * Starts a connection attempt of one provider's runtime and logs it if it
 * rejects.
 *
 * @param log - Application logger a failed attempt is written to.
 * @param provider - Provider the runtime connects to; written with a failure.
 * @param llmRuntimeConnector - The provider's runtime service.
 * @returns A promise that resolves once the attempt settled; it never rejects.
 * @remarks An attempt that rejects, such as one refused because the service
 * is closing, is logged as an error with its provider. An attempt that
 * reaches no provider resolves as `unreachable`, and its cause is already
 * reported through the provider's failure reporters.
 */
async function connectLlmProviderRuntime(
  log: FastifyBaseLogger,
  provider: LlmProvider,
  llmRuntimeConnector: LlmRuntimeConnector
): Promise<void> {
  try {
    await llmRuntimeConnector.connectLlmRuntime()
  } catch (error) {
    log.error(
      { provider, err: error },
      "Model provider runtime connection attempt failed"
    )
  }
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
  app.decorate("llmProviderServices", singletonServices.llmProviderServices)
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
}

/** Fastify plugin that opens the application-scoped singleton services. */
export default fastifyPlugin(openSingletonServices, {
  name: "singleton-services"
})
