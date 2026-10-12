import { writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
  readTavilyApiKey,
  type TavilyApiKeyRead
} from "../../../../../../src/infrastructure/settings/tavilyApiKeyFile"
import WebSearchToolProvider from "../../../../../../src/modules/tool/builtIn/web/webSearchToolProvider"
import WebSearchTool from "../../../../../../src/modules/tool/builtIn/web/webSearchTool"
import type { TavilyRequestDependencies } from "../../../../../../src/modules/tool/builtIn/web/tavilyRequest"
import { registerBuiltInToolProviderContractSuite } from "../../../../support/builtInToolProviderContract"
import { writeSettingsFile } from "../../../../support/settingsFile"
import {
  answerWithJson,
  startTavilyServer,
  TEST_TAVILY_API_KEY,
  type TavilyRoute
} from "../../../../support/tavilyServer"

/** Dependencies that never connect; for cases that send nothing. */
const UNUSED_DEPENDENCIES: TavilyRequestDependencies = Object.freeze({
  origin: "https://tavily.invalid",
  lookupHostAddresses: () => Promise.reject(new Error("never used")),
  isBlockedAddress: () => true,
  requestTimeoutMs: 1
})

/** Key read of a settings file holding the synthetic key. */
const CONFIGURED_KEY: TavilyApiKeyRead = Object.freeze({
  status: "configured",
  apiKey: TEST_TAVILY_API_KEY
})

/**
 * Creates a provider whose key read always gives one result.
 *
 * @param keyRead - What every key read gives.
 * @param dependencies - Where requests go.
 * @returns The provider.
 */
function createProvider(
  keyRead: TavilyApiKeyRead,
  dependencies: TavilyRequestDependencies = UNUSED_DEPENDENCIES
): WebSearchToolProvider {
  return new WebSearchToolProvider(() => Promise.resolve(keyRead), dependencies)
}

/**
 * Checks the key against a fake Tavily server.
 *
 * @param route - How the server answers.
 * @param overrides - Dependency changes.
 * @returns The check's answer.
 */
async function checkKey(
  route: TavilyRoute,
  overrides: Partial<TavilyRequestDependencies> = {}
) {
  const server = await startTavilyServer(route)
  return createProvider(CONFIGURED_KEY, {
    ...server.dependencies,
    ...overrides
  }).sendApiKeyCheck()
}

registerBuiltInToolProviderContractSuite("with a saved key", () =>
  Promise.resolve({
    provider: createProvider(CONFIGURED_KEY),
    expectedStatus: "ready"
  })
)

registerBuiltInToolProviderContractSuite("without a key", () =>
  Promise.resolve({
    provider: createProvider({ status: "missing" }),
    expectedStatus: "unavailable"
  })
)

describe("WebSearchToolProvider", () => {
  describe("findTurnTool", () => {
    it("gives a web search tool holding the saved key", async () => {
      const lookup = await createProvider(CONFIGURED_KEY).findTurnTool()

      expect(lookup.status).toBe("ready")
      expect(lookup.status === "ready" && lookup.tool).toBeInstanceOf(
        WebSearchTool
      )
    })

    it.each([
      [{ status: "missing" }, "api-key-missing"],
      [{ status: "invalid" }, "api-key-invalid"],
      [{ status: "unreadable" }, "settings-unreadable"]
    ] as const)("reports %o as %s", async (keyRead, reason) => {
      expect(await createProvider(keyRead).findTurnTool()).toEqual({
        status: "unavailable",
        reason
      })
    })

    it("keeps the key a turn started with after the key is removed", async () => {
      const server = await startTavilyServer(answerWithJson({ results: [] }))
      const path = await writeSettingsFile(
        JSON.stringify({ secrets: { tavilyApiKey: TEST_TAVILY_API_KEY } })
      )
      const provider = new WebSearchToolProvider(
        () => readTavilyApiKey(path),
        server.dependencies
      )
      const lookup = await provider.findTurnTool()
      if (lookup.status !== "ready") throw new Error("Expected a ready tool")

      await writeFile(path, JSON.stringify({ secrets: { tavilyApiKey: null } }))
      const parsed = lookup.tool.parseToolCall({ query: "moths" })
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")
      await parsed.runToolCall(new AbortController().signal)

      expect(server.receivedRequests[0]?.headers.authorization).toBe(
        `Bearer ${TEST_TAVILY_API_KEY}`
      )
      expect(await provider.findTurnTool()).toEqual({
        status: "unavailable",
        reason: "api-key-missing"
      })
    })
  })

  describe("sendApiKeyCheck", () => {
    it("reports an accepted key with its plan credits, without the key", async () => {
      const answer = await checkKey(
        answerWithJson({ account: { plan_usage: 37, plan_limit: 1000 } })
      )

      expect(answer).toEqual({
        status: "accepted",
        credits: { used: 37, limit: 1000 }
      })
      expect(JSON.stringify(answer)).not.toContain(TEST_TAVILY_API_KEY)
    })

    it("sends nothing without a usable key", async () => {
      const server = await startTavilyServer(answerWithJson({}))

      const answer = await createProvider(
        { status: "invalid" },
        server.dependencies
      ).sendApiKeyCheck()

      expect(answer).toEqual({
        status: "unavailable",
        reason: "api-key-invalid"
      })
      expect(server.receivedRequests).toHaveLength(0)
    })

    it.each([
      [401, { status: "rejected" }],
      [403, { status: "rejected" }],
      [429, { status: "failed", reason: "rate-limited" }],
      [500, { status: "failed", reason: "provider-error" }],
      [404, { status: "failed", reason: "provider-error" }]
    ])("maps HTTP %i", async (status, expected) => {
      expect(await checkKey(answerWithJson({}, status))).toEqual(expected)
    })

    it("maps a redirect to a provider error", async () => {
      const answer = await checkKey((_request, response) => {
        response.statusCode = 302
        response.setHeader("location", "https://elsewhere.example/")
        response.end()
      })

      expect(answer).toEqual({ status: "failed", reason: "provider-error" })
    })

    it("maps an answer it cannot read", async () => {
      expect(await checkKey(answerWithJson("not json {"))).toEqual({
        status: "failed",
        reason: "invalid-response"
      })
    })

    it("maps a slow check", async () => {
      const answer = await checkKey(
        () => {
          // Never answers.
        },
        { requestTimeoutMs: 50 }
      )

      expect(answer).toEqual({ status: "failed", reason: "timed-out" })
    })

    it("maps an address on this machine to unreachable", async () => {
      const answer = await checkKey(answerWithJson({}), {
        isBlockedAddress: () => true
      })

      expect(answer).toEqual({ status: "failed", reason: "unreachable" })
    })
  })
})
