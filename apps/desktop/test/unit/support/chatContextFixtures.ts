import type { ChatContextApiResponse } from "@lys/protocol"
import {
  buildJsonResponse,
  type BackendFake,
  type BackendRoutes,
  type ObservedBackendRequest
} from "./backendFake"

/** Route key of the context measurement. */
export const CHAT_CONTEXT_ROUTE = "POST /api/v1/chat/context"

/**
 * Measurement of a conversation without messages on an 8,192-token window,
 * which holds only the agent's system prompt.
 */
export const FIXTURE_CHAT_CONTEXT_MEASUREMENT: ChatContextApiResponse =
  Object.freeze({
    contextLength: 8192,
    systemPromptTokens: 2260,
    toolTokens: 0,
    historyTokens: 0,
    historyMessageCount: 0
  })

/**
 * Routes of a backend that answers every context measurement with
 * {@link FIXTURE_CHAT_CONTEXT_MEASUREMENT}, for cases that render a ready
 * composer without being about its meter.
 */
export const MEASURING_BACKEND_ROUTES: BackendRoutes = Object.freeze({
  [CHAT_CONTEXT_ROUTE]: () =>
    buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
})

/**
 * Lists the requests a backend received other than context measurements.
 *
 * @param backend - Observation handle of the case's backend.
 * @returns The other requests, in arrival order.
 */
export function listRequestsBesideMeasurements(
  backend: BackendFake
): readonly ObservedBackendRequest[] {
  return backend.requests.filter(
    (request) => request.routeKey !== CHAT_CONTEXT_ROUTE
  )
}
