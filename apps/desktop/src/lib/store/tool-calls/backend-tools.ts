import {
  hasHiddenWebSearchQueryCharacter,
  TAVILY_API_HOST,
  WEB_SEARCH_TOOL_NAME,
  type ChatToolCall
} from "@lys/protocol"
import {
  agentCodeSchema,
  DELEGATE_WORK_TOOL_NAME,
  MAXIMUM_JOB_TITLE_LENGTH,
  parseJobTitle
} from "@lys/share"

/** Validated input of one call to a tool the backend runs. */
export type BackendToolInput =
  | {
      /** The backend runs the tool once the call is allowed. */
      readonly runner: "backend"
      /** The read-page tool. */
      readonly toolName: "read_page"
      /** Normalized absolute http or https URL of the page. */
      readonly url: string
    }
  | {
      /** The backend runs the tool once the call is allowed. */
      readonly runner: "backend"
      /** The web search tool. */
      readonly toolName: typeof WEB_SEARCH_TOOL_NAME
      /**
       * Query exactly as the backend sends it: trimmed, not blank, and with
       * no character a person cannot reliably see.
       */
      readonly query: string
      /** Host of the search service the query is sent to. */
      readonly host: string
    }
  | {
      /** The backend runs the tool once the call is allowed. */
      readonly runner: "backend"
      /** The tool that gives work to another agent. */
      readonly toolName: typeof DELEGATE_WORK_TOOL_NAME
      /** Code of the agent the work goes to, as the model wrote it. */
      readonly agentCode: string
      /**
       * Title of the job exactly as the backend stores it: trimmed, on one
       * line, and 1 to `MAXIMUM_JOB_TITLE_LENGTH` characters long.
       */
      readonly title: string
      /**
       * Instructions exactly as the backend sends them to the agent: trimmed
       * and not blank. They are all the agent gets.
       */
      readonly instructions: string
      /** Number of the job the call continues; undefined for a new job. */
      readonly jobNumber: number | undefined
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
 * @returns `parsed` with the normalized URL, or `rejected` when
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
    url: parsedUrl.href
  })
  return Object.freeze({ status: "parsed", input })
}

/**
 * Parses the arguments of a web search call.
 *
 * @param call - Call naming the web search tool.
 * @returns `parsed` with the query trimmed exactly as the backend trims it
 * and the search service's host, or `rejected` when the query is not text,
 * is blank, or holds a character a person cannot reliably see, so that the
 * card never shows less than the query sent.
 * @remarks The backend checked the query before sending the call, its
 * length included; this check keeps the card from describing a query the
 * backend would not send.
 */
function parseWebSearchInput(call: ChatToolCall): BackendToolInputResult {
  const { query } = call.arguments
  const trimmed = typeof query === "string" ? query.trim() : ""
  if (trimmed === "" || hasHiddenWebSearchQueryCharacter(trimmed)) {
    return buildRejectedInput(
      `The arguments do not match ${call.toolName}: query: expected text that is not blank and holds no character hidden on screen.`
    )
  }

  const input: BackendToolInput = Object.freeze({
    runner: "backend",
    toolName: WEB_SEARCH_TOOL_NAME,
    query: trimmed,
    host: TAVILY_API_HOST
  })
  return Object.freeze({ status: "parsed", input })
}

/**
 * Parses an argument value as text that is not blank, as the backend does
 * for the text of a `delegate_work` call.
 *
 * @param value - Untrusted argument value.
 * @returns The trimmed text, or undefined when the value is not text or is
 * blank.
 */
function parseTrimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text === "" ? undefined : text
}

/**
 * Answers whether an argument value can be the number of a job.
 *
 * @param value - Untrusted argument value.
 * @returns True for a safe integer of 1 or more, which the backend accepts;
 * false for any other value, such as a fraction, zero, or text.
 */
function isJobNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/**
 * Parses the arguments of a `delegate_work` call.
 *
 * @param call - Call naming `delegate_work`.
 * @returns `parsed` with the agent code, the trimmed title and instructions,
 * and the number of the job a continuation names, or `rejected` for the
 * first argument the backend's own rules refuse: an agent that is not an
 * agent code, a title {@link parseJobTitle} refuses, blank instructions, or
 * a job that is not a whole number of 1 or more.
 * @remarks The backend refused such calls before it asked the person; this
 * check keeps the card from describing work the backend would not send.
 */
function parseDelegateWorkInput(call: ChatToolCall): BackendToolInputResult {
  const mismatch = `The arguments do not match ${call.toolName}:`
  const { agent, title, instructions } = call.arguments
  /** Number of the job to continue; a call that starts a job leaves it out. */
  const job: unknown = call.arguments.job
  const agentCode = agentCodeSchema.safeParse(agent)
  if (!agentCode.success) {
    return buildRejectedInput(`${mismatch} agent: expected an agent code.`)
  }
  const jobTitle = parseJobTitle(title)
  if (jobTitle === undefined) {
    return buildRejectedInput(
      `${mismatch} title: expected 1 to ${MAXIMUM_JOB_TITLE_LENGTH} characters on one line after trimming.`
    )
  }
  const jobInstructions = parseTrimmedText(instructions)
  if (jobInstructions === undefined) {
    return buildRejectedInput(
      `${mismatch} instructions: expected text that is not blank.`
    )
  }
  if (job !== undefined && !isJobNumber(job)) {
    return buildRejectedInput(
      `${mismatch} job: expected a whole number of 1 or more.`
    )
  }

  const input: BackendToolInput = Object.freeze({
    runner: "backend",
    toolName: DELEGATE_WORK_TOOL_NAME,
    agentCode: agentCode.data,
    title: jobTitle,
    instructions: jobInstructions,
    jobNumber: job
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
  if (call.toolName === "read_page") return parseReadPageInput(call)
  if (call.toolName === WEB_SEARCH_TOOL_NAME) return parseWebSearchInput(call)
  if (call.toolName === DELEGATE_WORK_TOOL_NAME) {
    return parseDelegateWorkInput(call)
  }
  return buildRejectedInput(
    `The desktop cannot describe the backend tool "${call.toolName}", so it was not run.`
  )
}
