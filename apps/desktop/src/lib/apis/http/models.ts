import {
  llmListModelsApi,
  llmLoadModelApi,
  llmTestModelApi,
  llmUnloadModelApi,
  llmServiceBusyProblemSchema,
  llmUnloadProblemSchema,
  type LlmInfo,
  type LlmTestModelApiResponse
} from "@lys/protocol"

/** Transport scope sampled once for one model operation. */
export type ModelApiConnection = {
  /** Application-owned backend origin. */
  readonly backendUrl: string
  /** Cancels local observation; accepted backend work can still complete. */
  readonly signal: AbortSignal
}

/** Complete HTTP request assembled by a model endpoint adapter. */
type ModelHttpRequest = ModelApiConnection & {
  /** Shared protocol route with any path parameter already encoded. */
  readonly path: string
  /** Method declared by the shared endpoint. */
  readonly method: string
  /** Serialized validated body, omitted for queries. */
  readonly body?: string
}

/**
 * Reads a model response, retaining declared safe errors and rejecting HTTP failures.
 * @param request - Endpoint and cancellation scope owned by the store.
 * @returns The response whose body remains owned by the endpoint decoder.
 * @throws On cancellation, transport failure, or a non-success HTTP response.
 */
async function getModelResponse(request: ModelHttpRequest): Promise<Response> {
  const response = await fetch(`${request.backendUrl}${request.path}`, {
    method: request.method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: request.signal,
    cache: "no-store"
  })
  if (!response.ok) throw await createModelResponseError(response)
  return response
}

/**
 * Projects declared Problem Details while withholding arbitrary server diagnostics.
 * @param response - Failed HTTP response consumed exactly once here.
 * @returns A safe error identifying the status or a validated protocol problem.
 */
async function createModelResponseError(response: Response): Promise<Error> {
  const fallback = new Error(`Model request failed (HTTP ${response.status}).`)
  try {
    const body: unknown = await response.json()
    const busy = llmServiceBusyProblemSchema.safeParse(body)
    if (busy.success && response.status === busy.data.status) {
      return new Error(busy.data.detail)
    }
    const problem = llmUnloadProblemSchema.safeParse(body)
    if (problem.success && response.status === problem.data.status) {
      return new Error(problem.data.detail)
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Decodes a successful model response without exposing raw malformed payloads.
 * @typeParam TPayload - Validated endpoint response type.
 * @param response - Successful response consumed by this boundary.
 * @param parsePayload - Authoritative shared schema parser for this endpoint.
 * @returns Validated endpoint data after the response body is consumed.
 * @throws A safe protocol error retaining the decoding failure as its cause.
 */
async function parseModelResponse<TPayload>(
  response: Response,
  parsePayload: (payload: unknown) => TPayload
): Promise<TPayload> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (response.status !== 200 || mediaType !== "application/json") {
      await response.body?.cancel()
      throw new Error("Unexpected model response status or media type.")
    }
    const payload: unknown = await response.json()
    return parsePayload(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid model response.", {
      cause
    })
  }
}

/**
 * Lists the downloaded models and their observed loaded state.
 * @param connection - Backend origin and local cancellation signal.
 * @returns A validated immutable inventory after the response is consumed.
 * @throws On transport, HTTP, JSON, or protocol validation failure.
 */
export async function listModels(
  connection: ModelApiConnection
): Promise<readonly LlmInfo[]> {
  const response = await getModelResponse({
    ...connection,
    path: llmListModelsApi.path,
    method: llmListModelsApi.method
  })
  const { llms } = await parseModelResponse(
    response,
    llmListModelsApi.responses[200].parse
  )
  const keys = new Set(llms.map((model) => model.modelKey))
  if (keys.size !== llms.length || keys.has("")) {
    throw new Error("The backend returned invalid or duplicate model keys.")
  }
  return llms
}

/**
 * Loads weights using only the fields accepted by the backend.
 * @param modelKey - Model key or alias to resolve at the runtime.
 * @param connection - Backend origin and local cancellation signal.
 * @returns Canonical model metadata after the backend confirms loading.
 * @throws On invalid input, transport, HTTP, JSON, or protocol failure.
 * @remarks Accepted loads can finish after local cancellation; no automatic retry occurs.
 */
export async function loadModel(
  modelKey: string,
  connection: ModelApiConnection
): Promise<LlmInfo> {
  const payload = llmLoadModelApi.body.parse({ modelId: modelKey })
  const response = await getModelResponse({
    ...connection,
    path: llmLoadModelApi.path,
    method: llmLoadModelApi.method,
    body: JSON.stringify(payload)
  })
  return await parseModelResponse(response, llmLoadModelApi.response.parse)
}

/**
 * Stops every loaded instance matching one canonical model key.
 * @param modelKey - Canonical inventory key to unload.
 * @param connection - Backend origin and local cancellation signal.
 * @returns Resolves only for the protocol's bodyless 204 acknowledgement.
 * @throws On invalid input, transport, declared failure, or an unexpected success status.
 */
export async function unloadModel(
  modelKey: string,
  connection: ModelApiConnection
): Promise<void> {
  const payload = llmUnloadModelApi.body.parse({ modelId: modelKey })
  const response = await getModelResponse({
    ...connection,
    path: llmUnloadModelApi.path,
    method: llmUnloadModelApi.method,
    body: JSON.stringify(payload)
  })
  if (response.status !== 204) {
    try {
      await response.body?.cancel()
    } catch (cause) {
      throw new Error(
        "The backend returned an invalid model unload response.",
        { cause }
      )
    }
    throw new Error("The backend returned an invalid model unload response.")
  }
}

/**
 * Observes loaded-state health without generating a completion.
 * @param modelKey - Canonical key within the shared route's decoded length limit.
 * @param connection - Backend origin and local cancellation signal.
 * @returns A validated ready or not-ready observation for the requested key.
 * @throws On invalid input, transport, HTTP, JSON, protocol, or identity mismatch.
 */
export async function getModelHealth(
  modelKey: string,
  connection: ModelApiConnection
): Promise<LlmTestModelApiResponse> {
  const { modelId } = llmTestModelApi.params.parse({ modelId: modelKey })
  const response = await getModelResponse({
    ...connection,
    method: llmTestModelApi.method,
    path: llmTestModelApi.path.replace(":modelId", encodeURIComponent(modelId))
  })
  const health = await parseModelResponse(
    response,
    llmTestModelApi.response.parse
  )
  if (health.modelId !== modelId)
    throw new Error("The backend returned health for a different model.")
  return health
}
