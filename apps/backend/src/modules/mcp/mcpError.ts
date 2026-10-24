import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError
} from "@modelcontextprotocol/client"
import { McpResponseTooLargeError } from "./mcpResponseLimit"

/**
 * What one failure of an MCP request was, as far as Lys tells failures
 * apart.
 *
 * @remarks `timed-out`: the request's own time limit passed. `closed`: the
 * process exited or the connection ended. `http-status`: the server answered
 * with an HTTP status the transport refuses, such as 401, 500, or a
 * redirect. `unreachable`: no HTTP connection could be made. `start-failed`:
 * the stdio command could not be started. `refused`: the server answered
 * with a JSON-RPC error, whose message is the server's untrusted text.
 * `invalid-answer`: the server's answer is not valid MCP. `too-large`: an
 * HTTP answer was longer than `MAXIMUM_MCP_RESPONSE_BYTES`, so Lys stopped
 * reading it. `unknown`: none of these, which is logged as a possible
 * defect.
 */
export type McpRequestFailure =
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{
      kind: "http-status"
      /** HTTP status the server answered. */
      status: number
    }>
  | Readonly<{ kind: "unreachable" }>
  | Readonly<{ kind: "start-failed" }>
  | Readonly<{
      kind: "refused"
      /** Message of the JSON-RPC error, as the server wrote it. */
      message: string
    }>
  | Readonly<{ kind: "invalid-answer" }>
  | Readonly<{ kind: "too-large" }>
  | Readonly<{ kind: "unknown" }>

/** Most causes {@link classifyMcpRequestFailure} follows before it gives up. */
const MAXIMUM_CAUSE_DEPTH = 4

/** Message of the error Node's `fetch` throws when no connection could be made. */
const FETCH_FAILED_MESSAGE = "fetch failed"

/** Failure kinds that carry no detail, shared by every classification. */
const FAILURES = Object.freeze({
  timedOut: Object.freeze({ kind: "timed-out" }),
  closed: Object.freeze({ kind: "closed" }),
  unreachable: Object.freeze({ kind: "unreachable" }),
  startFailed: Object.freeze({ kind: "start-failed" }),
  invalidAnswer: Object.freeze({ kind: "invalid-answer" }),
  tooLarge: Object.freeze({ kind: "too-large" }),
  unknown: Object.freeze({ kind: "unknown" })
} satisfies Readonly<Record<string, McpRequestFailure>>)

/**
 * Classifies one failure of an MCP request or of opening a connection.
 *
 * @param error - What the SDK or the transport threw, after the caller
 * ruled out its own cancellation.
 * @returns The failure's kind. A failure the SDK wraps, such as a failed
 * send or a failed protocol negotiation, is classified by its cause, at most
 * {@link MAXIMUM_CAUSE_DEPTH} causes deep.
 * @remarks The SDK reports a cancelled request as a timeout too, so a caller
 * that cancels must check its own signal before it calls this.
 */
export function classifyMcpRequestFailure(error: unknown): McpRequestFailure {
  let current: unknown = error
  for (let depth = 0; depth <= MAXIMUM_CAUSE_DEPTH; depth += 1) {
    const failure = classifyOwnFailure(current)
    if (failure !== undefined) return failure
    if (!(current instanceof Error) || current.cause === undefined) break
    current = current.cause
  }
  return FAILURES.unknown
}

/**
 * Classifies one error without its cause.
 *
 * @param error - One error of a chain.
 * @returns Its failure kind, or undefined when only its cause can tell.
 */
function classifyOwnFailure(error: unknown): McpRequestFailure | undefined {
  if (error instanceof SdkHttpError)
    return Object.freeze({ kind: "http-status", status: error.status })
  if (error instanceof SdkError) return classifySdkFailure(error)
  if (error instanceof ProtocolError)
    return Object.freeze({ kind: "refused", message: error.message })
  if (error instanceof SyntaxError) return FAILURES.invalidAnswer
  if (error instanceof McpResponseTooLargeError) return FAILURES.tooLarge
  if (error instanceof TypeError && error.message === FETCH_FAILED_MESSAGE)
    return FAILURES.unreachable
  if (isSpawnFailure(error)) return FAILURES.startFailed
  return undefined
}

/**
 * Classifies one of the SDK's own errors.
 *
 * @param error - SDK error that is not an HTTP error.
 * @returns Its failure kind, or undefined for an error that wraps the cause
 * that tells, such as a failed send or a failed protocol negotiation.
 */
function classifySdkFailure(error: SdkError): McpRequestFailure | undefined {
  switch (error.code) {
    case SdkErrorCode.RequestTimeout:
      return FAILURES.timedOut
    case SdkErrorCode.ConnectionClosed:
    case SdkErrorCode.NotConnected:
      return FAILURES.closed
    case SdkErrorCode.SendFailed:
    case SdkErrorCode.EraNegotiationFailed:
      return error.cause === undefined ? FAILURES.invalidAnswer : undefined
    default:
      return FAILURES.invalidAnswer
  }
}

/**
 * Answers whether an error is Node's failure to start a process.
 *
 * @param error - Error to inspect.
 * @returns True for an error whose `syscall` names a spawn, such as
 * `spawn npx` with `ENOENT` when the command is not found. Such an error
 * holds the command and its arguments.
 */
export function isSpawnFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  )
}
