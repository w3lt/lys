/**
 * Time one provider request may take, from sending it to reading its whole
 * answer, in milliseconds.
 *
 * @remarks A provider that never answers would otherwise keep a model
 * operation, and the queue behind it, waiting forever. Listing and showing
 * models takes far less on a working provider.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000

/**
 * Most bytes of one provider answer read, inclusive; a longer answer is a
 * failure. A model list with its metadata stays far below it.
 */
export const MAXIMUM_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024

/** Decoder that rejects bytes that are not UTF-8. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/** One JSON request to a provider's HTTP API: a `GET`, or a `POST` with a body. */
export type ProviderJsonRequest =
  | Readonly<{
      /** Absolute URL; never holds a secret. */
      url: string
      /** Reads a resource; the request has no body. */
      method: "GET"
      /** Bearer credential sent in the `Authorization` header, if any; a secret. */
      apiKey: string | undefined
    }>
  | Readonly<{
      /** Absolute URL; never holds a secret. */
      url: string
      /** Sends {@link body} as JSON. */
      method: "POST"
      /** Bearer credential sent in the `Authorization` header, if any; a secret. */
      apiKey: string | undefined
      /** Value sent as the JSON body. */
      body: unknown
    }>

/**
 * Sends one request to a provider and reads its JSON answer.
 *
 * @param request - Request to send.
 * @param timeoutMs - Deadline of the whole request, in milliseconds;
 * {@link PROVIDER_REQUEST_TIMEOUT_MS} when omitted.
 * @returns The parsed answer, untrusted and unchecked.
 * @throws `The provider did not answer within <timeoutMs> ms.` when the
 * deadline passes, with the abort as its cause; otherwise an error naming
 * the HTTP status when the answer is not 2xx, the size limit when the answer
 * passes {@link MAXIMUM_PROVIDER_RESPONSE_BYTES}, or that the answer is not
 * JSON; a transport failure keeps its cause. No message holds the key or the
 * answer's text.
 * @remarks The deadline covers sending, waiting, and reading the body.
 */
export async function requestProviderJson(
  request: ProviderJsonRequest,
  timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return await exchangeProviderJson(request, signal)
  } catch (exchangeError) {
    if (signal.aborted) {
      throw new Error(`The provider did not answer within ${timeoutMs} ms.`, {
        cause: exchangeError
      })
    }
    throw exchangeError
  }
}

/**
 * Sends one request to a provider and reads its JSON answer, until the
 * signal aborts.
 *
 * @param request - Request to send.
 * @param signal - Aborts sending, waiting, and reading the body.
 * @returns The parsed answer, untrusted and unchecked.
 * @throws The failures {@link requestProviderJson} describes, with the
 * abort's own failure when the signal aborts.
 */
async function exchangeProviderJson(
  request: ProviderJsonRequest,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: buildProviderHeaders(request),
    ...(request.method === "POST"
      ? { body: JSON.stringify(request.body) }
      : {}),
    signal
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`The provider answered with HTTP ${response.status}.`)
  }
  return parseProviderJson(await readBoundedProviderBody(response))
}

/**
 * Builds the headers of one provider request.
 *
 * @param request - Request to send.
 * @returns JSON headers, with a bearer `Authorization` header when the
 * request has a key.
 */
function buildProviderHeaders(
  request: ProviderJsonRequest
): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" }
  if (request.method === "POST") headers["content-type"] = "application/json"
  if (request.apiKey !== undefined) {
    headers.authorization = `Bearer ${request.apiKey}`
  }
  return headers
}

/**
 * Reads a provider answer's body up to the size limit.
 *
 * @param response - Answer whose headers arrived.
 * @returns The whole body.
 * @throws When the body passes {@link MAXIMUM_PROVIDER_RESPONSE_BYTES}, after
 * cancelling the rest, or when reading fails.
 */
async function readBoundedProviderBody(
  response: Response
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let byteCount = 0
  if (response.body === null) return new Uint8Array()
  for await (const chunk of response.body) {
    byteCount += chunk.byteLength
    if (byteCount > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
      throw new Error(
        `The provider's answer is longer than ${MAXIMUM_PROVIDER_RESPONSE_BYTES} bytes.`
      )
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Parses a provider answer's body as UTF-8 JSON.
 *
 * @param bytes - Whole body.
 * @returns The parsed value, untrusted.
 * @throws `The provider's answer is not JSON.` without the parse failure,
 * whose message can quote the body.
 */
function parseProviderJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(UTF8_DECODER.decode(bytes))
  } catch {
    throw new Error("The provider's answer is not JSON.")
  }
}
