import {
  chatNotificationApi,
  chatSpeechApi,
  DICTATION_CLOSE_SUPERSEDED,
  SPEECH_CLOSE_SUPERSEDED,
  voiceDictationApi,
  type ChatNotificationApiRoute,
  type ChatSpeechApiRoute
} from "@lys/protocol"
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify"
import type { WebSocket } from "ws"
import { isAllowedOrigin } from "../../httpOrigins"
import {
  handleDictationConnection,
  type DictationConnectionDependencies
} from "./dictationConnection"
import { getNotificationLine } from "./notificationLines"
import { SingleSocketRegistry } from "./singleSocketRegistry"
import {
  handleSpeechConnection,
  type SpeechConnectionDependencies
} from "./speechConnection"
import {
  isVoiceReady,
  openVoiceDictation,
  openVoiceSpeech
} from "./voiceClient"

/** Problem Details media type of the origin refusal. */
const PROBLEM_MEDIA_TYPE = "application/problem+json"

/** Options the voice routes borrow; defaults talk to the real voice. */
export type VoiceRouteOptions = Readonly<{
  /** Probe whether voice is ready; defaults to the real health check. */
  isReady?: () => Promise<boolean>
  /** Open a speech at voice; defaults to the real connection. */
  openVoiceSpeech?: typeof openVoiceSpeech
  /** Open a dictation at voice; defaults to the real connection. */
  openVoiceDictation?: typeof openVoiceDictation
}>

/**
 * Registers the speech, notification, and dictation WebSocket routes.
 *
 * @param app - Application with WebSocket support, the conversation history
 * reader, and the reply generation registry every turn start registers its
 * generation with; the registry's owner disposes of it.
 * @param options - Test seams for the voice probe and connections; empty in
 * the application.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register a route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks The speech and notification sockets speak for one reply each,
 * and one socket speaks at a time across both. The dictation socket turns
 * what the person says into text, one dictation at a time. All three accept
 * the backend's desktop origins only; a browser page sending another
 * `Origin` is refused before the upgrade, and everything else is local, as
 * with the HTTP routes.
 */
export default function registerVoiceRoutes(
  app: FastifyInstance,
  options: VoiceRouteOptions = {}
): Promise<void> {
  return new Promise((resolve) => {
    registerSpeechSocketRoutes(app, createSpeechDependencies(app, options))
    registerDictationSocketRoute(app, createDictationDependencies(options))
    resolve()
  })
}

/**
 * Gathers the dependencies both socket endpoints share.
 *
 * @param app - Application with the conversation history reader and the
 * reply generation registry installed; both are read once, here.
 * @param options - Test seams for the voice probe and connection.
 * @returns The dependencies, with one new socket registry.
 */
function createSpeechDependencies(
  app: FastifyInstance,
  options: VoiceRouteOptions
): SpeechConnectionDependencies {
  return Object.freeze({
    history: app.conversationHistoryReader,
    generations: app.replyGenerations,
    registry: new SingleSocketRegistry(SPEECH_CLOSE_SUPERSEDED),
    isReady: options.isReady ?? isVoiceReady,
    openVoiceSpeech: options.openVoiceSpeech ?? openVoiceSpeech
  })
}

/**
 * Gathers the dependencies of the dictation endpoint.
 *
 * @param options - Test seams for the voice probe and connection.
 * @returns The dependencies, with one new socket registry.
 */
function createDictationDependencies(
  options: VoiceRouteOptions
): DictationConnectionDependencies {
  return Object.freeze({
    registry: new SingleSocketRegistry(DICTATION_CLOSE_SUPERSEDED),
    isReady: options.isReady ?? isVoiceReady,
    openVoiceDictation: options.openVoiceDictation ?? openVoiceDictation
  })
}

/**
 * Registers the dictation endpoint.
 *
 * @param app - Application with WebSocket support.
 * @param deps - The endpoint's dependencies, including the socket registry
 * that lets a single socket dictate at a time.
 * @throws If route registration fails.
 */
function registerDictationSocketRoute(
  app: FastifyInstance,
  deps: DictationConnectionDependencies
): void {
  app.route({
    method: voiceDictationApi.method,
    url: voiceDictationApi.path,
    websocket: true,
    preValidation: handleSocketPreValidation,
    handler: (socket: WebSocket, request: FastifyRequest) =>
      handleDictationConnection({ socket, deps, log: request.log })
  })
}

/**
 * Registers the two socket endpoints over one set of dependencies.
 *
 * @param app - Application with WebSocket support.
 * @param deps - Dependencies both endpoints share, including the one
 * socket registry that lets a single socket speak at a time.
 * @throws If route registration fails.
 */
function registerSpeechSocketRoutes(
  app: FastifyInstance,
  deps: SpeechConnectionDependencies
): void {
  app.route<ChatSpeechApiRoute>({
    method: chatSpeechApi.method,
    url: chatSpeechApi.path,
    websocket: true,
    schema: {
      params: chatSpeechApi.params,
      querystring: chatSpeechApi.querystring
    },
    preValidation: handleSocketPreValidation,
    handler: (socket: WebSocket, request: FastifyRequest<ChatSpeechApiRoute>) =>
      handleSpeechConnection({
        socket,
        target: request.params,
        request: { kind: "reply", from: request.query.from },
        deps,
        log: createSpeechLog(request)
      })
  })

  app.route<ChatNotificationApiRoute>({
    method: chatNotificationApi.method,
    url: chatNotificationApi.path,
    websocket: true,
    schema: { params: chatNotificationApi.params },
    preValidation: handleSocketPreValidation,
    handler: (
      socket: WebSocket,
      request: FastifyRequest<ChatNotificationApiRoute>
    ) =>
      handleSpeechConnection({
        socket,
        target: request.params,
        request: { kind: "notification", line: getNotificationLine() },
        deps,
        log: createSpeechLog(request)
      })
  })
}

/**
 * Creates the logger of one speech socket.
 *
 * @param request - Its upgrade request, with the validated reply address.
 * @returns A child of the request's logger that names the reply.
 */
function createSpeechLog(
  request: FastifyRequest<ChatSpeechApiRoute | ChatNotificationApiRoute>
): FastifyBaseLogger {
  return request.log.child({
    conversationId: request.params.conversationId,
    assistantMessageId: request.params.assistantMessageId
  })
}

/**
 * Refuses a WebSocket upgrade whose `Origin` is not a desktop origin.
 *
 * @param request - The upgrade request.
 * @param reply - Its reply, sent a `403` Problem Details body on refusal.
 * @param done - Continues the upgrade when called without an error.
 * @remarks Runs before the upgrade, so a web page is turned away without a
 * socket; requests without an `Origin`, such as ones from local processes,
 * are allowed, as with the HTTP routes.
 */
function handleSocketPreValidation(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (error?: Error) => void
): void {
  if (isAllowedOrigin(request.headers.origin)) {
    done()
    return
  }
  request.log.warn(
    { origin: request.headers.origin },
    "Voice socket refused a foreign origin"
  )
  void reply.type(PROBLEM_MEDIA_TYPE).code(403).send({
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "This origin is not allowed to open a socket."
  })
}
