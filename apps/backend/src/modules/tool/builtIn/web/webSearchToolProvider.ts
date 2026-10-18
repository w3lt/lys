import type {
  CheckWebSearchKeyApiResponse,
  WebSearchKeyCheckFailure,
  WebSearchKeyUnavailableReason
} from "@lys/protocol"
import type { TavilyApiKeyRead } from "../../../../infrastructure/settings/tavilyApiKeyFile"
import type { TurnToolLookup, BuiltInToolProvider } from "../builtInTool"
import { sendTavilyUsageRequest, type TavilyUsageOutcome } from "./tavilyApi"
import type {
  TavilyRequestDependencies,
  TavilyRequestFailure
} from "./tavilyRequest"
import WebSearchTool from "./webSearchTool"

/**
 * Reads the Tavily API key saved now; each call reads again. Resolves for
 * every expected state of the settings file.
 */
export type ReadTavilyApiKey = () => Promise<TavilyApiKeyRead>

/** Key read that holds no usable key. */
type UnusableTavilyApiKeyRead = Exclude<
  TavilyApiKeyRead,
  { status: "configured" }
>

/** Unavailable reason of each key read without a usable key. */
const UNAVAILABLE_REASONS = Object.freeze({
  missing: "api-key-missing",
  invalid: "api-key-invalid",
  unreadable: "settings-unreadable"
} satisfies Readonly<
  Record<UnusableTavilyApiKeyRead["status"], WebSearchKeyUnavailableReason>
>)

/** Key-check answer of a rejected key. */
const REJECTED_KEY: CheckWebSearchKeyApiResponse = Object.freeze({
  status: "rejected"
})

/**
 * Builds the key-check answer of a check that could not tell.
 *
 * @param reason - Why.
 * @returns A frozen failed answer.
 */
function buildFailedKeyCheck(
  reason: WebSearchKeyCheckFailure
): CheckWebSearchKeyApiResponse {
  return Object.freeze({ status: "failed", reason })
}

/**
 * Builds the key-check answer of a usage request that failed.
 *
 * @param failure - Recognized request failure.
 * @returns `rejected` for 401 and 403; otherwise why the check could not
 * tell.
 */
function buildFailedUsageKeyCheck(
  failure: TavilyRequestFailure
): CheckWebSearchKeyApiResponse {
  switch (failure.kind) {
    case "http-status":
      return buildHttpStatusKeyCheck(failure.status)
    case "timed-out":
      return buildFailedKeyCheck("timed-out")
    case "unreachable":
    case "unresolvable-host":
    case "blocked-address":
      return buildFailedKeyCheck("unreachable")
    case "redirected":
      return buildFailedKeyCheck("provider-error")
    case "too-large":
    case "unreadable":
      return buildFailedKeyCheck("invalid-response")
  }
}

/**
 * Builds the key-check answer of an HTTP error status.
 *
 * @param status - Status other than 2xx or 3xx.
 * @returns `rejected` for 401 and 403, `rate-limited` for 429, and a
 * provider error otherwise.
 */
function buildHttpStatusKeyCheck(status: number): CheckWebSearchKeyApiResponse {
  if (status === 401 || status === 403) return REJECTED_KEY
  if (status === 429) return buildFailedKeyCheck("rate-limited")
  return buildFailedKeyCheck("provider-error")
}

/**
 * Builds the key-check answer of a usage request.
 *
 * @param outcome - Outcome of the usage request.
 * @returns `accepted` with the plan credits, or what the failure means.
 */
function buildUsageKeyCheck(
  outcome: TavilyUsageOutcome
): CheckWebSearchKeyApiResponse {
  if (outcome.status === "failed")
    return buildFailedUsageKeyCheck(outcome.failure)
  return Object.freeze({ status: "accepted", credits: outcome.credits })
}

/**
 * Owns the key source and Tavily request settings to give each turn a web
 * search tool holding the key saved when the turn starts, and to check that
 * key with Tavily.
 *
 * @remarks Implements {@link BuiltInToolProvider}. Every lookup and
 * check reads the key again, so a saved or removed key applies to the next
 * turn or check without restarting the backend. Neither result ever holds
 * the key. Owns no resource. Concurrency model: reentrant.
 */
export default class WebSearchToolProvider implements BuiltInToolProvider {
  /** Reads the key saved now. */
  readonly #readApiKey: ReadTavilyApiKey
  /** Origin, address rule, and time limit of every request. */
  readonly #requestDependencies: TavilyRequestDependencies

  /**
   * Creates the provider without reading or contacting anything.
   *
   * @param readApiKey - Reads the key saved now, lent for the provider's
   * lifetime.
   * @param requestDependencies - Origin, address rule, and time limit, lent
   * for the provider's lifetime.
   */
  public constructor(
    readApiKey: ReadTavilyApiKey,
    requestDependencies: TavilyRequestDependencies
  ) {
    this.#readApiKey = readApiKey
    this.#requestDependencies = requestDependencies
  }

  /**
   * Implements {@link BuiltInToolProvider.findTurnTool} for web searches.
   *
   * @returns The interface-defined outcome: `ready` with a tool holding the
   * key saved now; `unavailable` with `api-key-missing`, `api-key-invalid`,
   * or `settings-unreadable` otherwise.
   */
  public async findTurnTool(): Promise<TurnToolLookup> {
    const keyRead = await this.#readApiKey()
    if (keyRead.status !== "configured") {
      return Object.freeze({
        status: "unavailable",
        reason: UNAVAILABLE_REASONS[keyRead.status]
      })
    }
    const tool = new WebSearchTool(keyRead.apiKey, this.#requestDependencies)
    return Object.freeze({ status: "ready", tool })
  }

  /**
   * Checks the key saved now with Tavily's usage endpoint, which spends no
   * search.
   *
   * @returns `accepted` with the plan credits when Tavily reports them,
   * `rejected` when Tavily refuses the key, `unavailable` without sending
   * anything when no usable key is saved, or `failed` with why the check
   * could not tell.
   * @throws Only on a defect.
   * @remarks The check ends within the request time limit; nothing stops it
   * earlier.
   */
  public async sendApiKeyCheck(): Promise<CheckWebSearchKeyApiResponse> {
    const keyRead = await this.#readApiKey()
    if (keyRead.status !== "configured") {
      return Object.freeze({
        status: "unavailable",
        reason: UNAVAILABLE_REASONS[keyRead.status]
      })
    }
    const outcome = await sendTavilyUsageRequest(
      keyRead.apiKey,
      new AbortController().signal,
      this.#requestDependencies
    )
    return buildUsageKeyCheck(outcome)
  }
}
