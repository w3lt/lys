import type { ChatToolAnswer, ChatToolCall } from "@lys/protocol"

/** Validated input of one call to a tool the backend runs. */
export type BackendToolInput = {
  /** The backend runs the tool once the call is allowed. */
  readonly runner: "backend"
  /** The read-page tool. */
  readonly toolName: "read_page"
  /** Normalized absolute http or https URL of the page. */
  readonly url: string
  /** Host the request goes to, with its port when it has one. */
  readonly host: string
}

/** Outcome of checking one backend call's tool name and arguments. */
export type BackendToolInputResult =
  | {
      /** The person can be shown what the call does. */
      readonly status: "parsed"
      /** Validated input. */
      readonly input: BackendToolInput
    }
  | {
      /** The desktop cannot describe the call, so it is not allowed. */
      readonly status: "rejected"
      /** Explanation the model reads. */
      readonly content: string
    }

/** Answer that lets the backend run one call of its tool. */
export const ALLOWED_TOOL_ANSWER: ChatToolAnswer = Object.freeze({
  status: "allowed"
})

/** URL schemes the read-page tool reads, as the URL parser reports them. */
const PAGE_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"])

/**
 * Builds the rejected outcome of a call the desktop cannot describe.
 *
 * @param content - Explanation the model reads.
 * @returns A frozen rejected outcome.
 */
function buildRejectedInput(content: string): BackendToolInputResult {
  return Object.freeze({ status: "rejected", content })
}

/**
 * Parses a URL text as the URL parser the backend uses does.
 *
 * @param text - Untrusted URL text.
 * @returns The parsed URL, or undefined when the text is not an absolute URL.
 */
function parseAbsoluteUrl(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

/**
 * Parses the arguments of a read-page call.
 *
 * @param call - Call naming the read-page tool.
 * @returns `parsed` with the normalized URL and its host, or `rejected` when
 * the URL is not text or not an absolute http or https URL.
 * @remarks The backend checked the URL before sending the call; this check
 * keeps the card from describing a URL the backend would not read.
 */
function parseReadPageInput(call: ChatToolCall): BackendToolInputResult {
  const { url } = call.arguments
  const parsedUrl = typeof url === "string" ? parseAbsoluteUrl(url) : undefined
  if (parsedUrl === undefined || !PAGE_URL_PROTOCOLS.has(parsedUrl.protocol)) {
    return buildRejectedInput(
      `The arguments do not match ${call.toolName}: url: expected an absolute http or https URL.`
    )
  }

  const input: BackendToolInput = Object.freeze({
    runner: "backend",
    toolName: "read_page",
    url: parsedUrl.href,
    host: parsedUrl.host
  })
  return Object.freeze({ status: "parsed", input })
}

/**
 * Parses one call into the input of a backend tool the desktop can describe.
 *
 * @param call - Call whose arguments the backend checked against the tool's
 * definition and the tool's own argument rules.
 * @returns `parsed` with the validated input, or `rejected` when the desktop
 * has no description for the tool or the arguments do not match it.
 */
export function parseBackendToolInput(
  call: ChatToolCall
): BackendToolInputResult {
  switch (call.toolName) {
    case "read_page":
      return parseReadPageInput(call)
    default:
      return buildRejectedInput(
        `The desktop cannot describe the backend tool "${call.toolName}", so it was not run.`
      )
  }
}
