import {
  chatNotificationApi,
  chatSpeechApi,
  type ChatNotificationApiRoute,
  type ChatSpeechApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import { isAllowedOrigin } from "../../httpOrigins"
import type ReplyGenerationRegistry from "../chat/replyGenerationRegistry"
import { pickNotificationLine } from "./notificationLines"
import { SpeechSocketRegistry } from "./speechSocketRegistry"
import {
  handleSpeechConnection,
  type SpeechConnectionDependencies
} from "./speechConnection"
import { connectVoiceSpeech, isVoiceReady } from "./voiceClient"

/** Options the speech routes borrow; defaults speak to the real voice. */
export type SpeechRouteOptions = Readonly<{
  /** Probe whether voice is ready; defaults to the real health check. */
  isReady?: typeof isVoiceReady
  /** Open a speech to voice; defaults to the real connection. */
  connect?: typeof connectVoiceSpeech
}>

/**
 * Installs the speech WebSocket routes.
 *
 * @param app - Backend with HTTP transport and the conversation history
 * reader registered.
 * @param generations - Registry shared with the chat route.
 * @param options - Test seams for the voice probe and connection.
 * @throws If route registration fails.
 * @remarks The two sockets speak for one reply each. They accept the
 * backend's desktop origins only; a browser page sending another `Origin`
 * is refused before the upgrade, and everything else is local, as with the
 * HTTP routes.
 */
export default function updateFastifyWithSpeechRoutes(
  app: FastifyInstance,
  generations: ReplyGenerationRegistry,
  options: SpeechRouteOptions = {}
): void {
  const registry = new SpeechSocketRegistry()
  const deps: SpeechConnectionDependencies = {
    history: app.conversationHistoryReader,
    generations,
    registry,
    isReady: options.isReady ?? isVoiceReady,
    connect: options.connect ?? connectVoiceSpeech
  }

  app.route<ChatSpeechApiRoute>({
    method: chatSpeechApi.method,
    url: chatSpeechApi.path,
    websocket: true,
    schema: {
      params: chatSpeechApi.params,
      querystring: chatSpeechApi.querystring
    },
    preValidation: refuseForeignOrigins,
    handler: (socket: WebSocket, request: FastifyRequest<ChatSpeechApiRoute>) =>
      handleSpeechConnection({
        socket,
        target: request.params,
        request: { kind: "reply", from: request.query.from },
        deps
      })
  })

  app.route<ChatNotificationApiRoute>({
    method: chatNotificationApi.method,
    url: chatNotificationApi.path,
    websocket: true,
    schema: { params: chatNotificationApi.params },
    preValidation: refuseForeignOrigins,
    handler: (
      socket: WebSocket,
      request: FastifyRequest<ChatNotificationApiRoute>
    ) =>
      handleSpeechConnection({
        socket,
        target: request.params,
        request: { kind: "notification", line: pickNotificationLine() },
        deps
      })
  })
}

/**
 * Refuses a WebSocket upgrade whose `Origin` is not a desktop origin.
 *
 * @remarks Runs before the upgrade, so a web page is turned away without a
 * socket; requests without an `Origin`, such as ones from local processes,
 * are allowed, as with the HTTP routes.
 */
function refuseForeignOrigins(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (error?: Error) => void
): void {
  if (isAllowedOrigin(request.headers.origin)) {
    done()
    return
  }
  void reply.code(403).send({
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "This origin is not allowed to open a socket."
  })
}
