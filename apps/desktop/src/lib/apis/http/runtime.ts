import {
  apiHeathCheckRoute,
  llmRuntimeConnectApi,
  llmRuntimeConnectionApiResponseSchema,
  llmRuntimeStatusApi,
  type LlmRuntimeConnectionStatus
} from "@lys/protocol"
import type { ModelApiConnection } from "./models"

/** Whether the backend HTTP listener answered one health check. */
export type BackendHealth = "answering" | "not-answering"

/**
 * Checks whether the backend HTTP listener answers its health route.
 *
 * @param backendUrl - Backend origin to check.
 * @returns `answering` after a successful health response within one second,
 * otherwise `not-answering`.
 * @remarks Transport failures, timeouts, and unsuccessful statuses are the
 * expected not-yet-ready outcome, so this check never rejects. The response
 * body is discarded.
 */
export async function getBackendHealth(
  backendUrl: string
): Promise<BackendHealth> {
  const healthCheckTimeoutMs = 1000
  try {
    const response = await fetch(`${backendUrl}${apiHeathCheckRoute}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(healthCheckTimeoutMs)
    })
    await response.body?.cancel()
    return response.ok ? "answering" : "not-answering"
  } catch {
    return "not-answering"
  }
}

/**
 * Reads the backend's LM Studio connection status without contacting LM Studio.
 *
 * @param connection - Backend origin and local cancellation signal.
 * @returns The validated status reported by the backend.
 * @throws On cancellation, transport, HTTP, JSON, or protocol validation failure.
 */
export async function getLlmRuntimeConnectionStatus(
  connection: ModelApiConnection
): Promise<LlmRuntimeConnectionStatus> {
  const response = await fetch(
    `${connection.backendUrl}${llmRuntimeStatusApi.path}`,
    {
      method: llmRuntimeStatusApi.method,
      headers: { Accept: "application/json" },
      signal: connection.signal,
      cache: "no-store"
    }
  )
  return await parseLlmRuntimeConnectionResponse(response)
}

/**
 * Asks the backend to connect to LM Studio and waits for the settled status.
 *
 * @param connection - Backend origin and local cancellation signal.
 * @returns `connected` or `unreachable` once the backend's attempt settles.
 * @throws On cancellation, transport, HTTP (including the service-busy 503),
 * JSON, or protocol validation failure.
 * @remarks Cancelling the signal stops local observation only; the backend
 * completes an accepted attempt.
 */
export async function connectLlmRuntime(
  connection: ModelApiConnection
): Promise<LlmRuntimeConnectionStatus> {
  const response = await fetch(
    `${connection.backendUrl}${llmRuntimeConnectApi.path}`,
    {
      method: llmRuntimeConnectApi.method,
      headers: { Accept: "application/json" },
      signal: connection.signal,
      cache: "no-store"
    }
  )
  return await parseLlmRuntimeConnectionResponse(response)
}

/**
 * Decodes one runtime connection response without exposing raw payloads.
 *
 * @param response - Response consumed exactly once here.
 * @returns The validated status.
 * @throws A safe error for an unsuccessful status or an invalid payload,
 * retaining the decoding failure as its cause.
 */
async function parseLlmRuntimeConnectionResponse(
  response: Response
): Promise<LlmRuntimeConnectionStatus> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `LM Studio status request failed (HTTP ${response.status}).`
    )
  }

  try {
    const payload: unknown = await response.json()
    return llmRuntimeConnectionApiResponseSchema.parse(payload).status
  } catch (cause) {
    throw new Error("The backend returned an invalid LM Studio status.", {
      cause
    })
  }
}
