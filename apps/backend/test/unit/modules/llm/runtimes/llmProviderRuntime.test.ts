import {
  groqApiKeySchema,
  ollamaApiKeySchema,
  providerAddressSchema
} from "@lys/share"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import GroqRuntime from "../../../../../src/modules/llm/runtimes/groqRuntime"
import { acquireLlmProviderRuntime } from "../../../../../src/modules/llm/runtimes/llmProviderRuntime"
import LmStudioRuntime from "../../../../../src/modules/llm/runtimes/lmStudioRuntime"
import OllamaRuntime from "../../../../../src/modules/llm/runtimes/ollamaRuntime"
import type { AcquiredLlmRuntime } from "../../../../../src/modules/llm/llmRuntime"
import {
  DISCARDING_SDK_LOGGER,
  fakeLmStudio
} from "../../../support/lmStudioSdkFake"
import {
  answerWith,
  startProviderServer
} from "../../../support/providerServer"

vi.mock("@lmstudio/sdk", () => import("../../../support/lmStudioSdkFake"))

/** Synthetic Ollama key; not a real credential. */
const OLLAMA_KEY = ollamaApiKeySchema.parse("ollama-synthetic-0123456789")

/** Synthetic Groq key; not a real credential. */
const GROQ_KEY = groqApiKeySchema.parse("gsk_synthetic_0123456789")

/**
 * Disposes an acquired runtime when the current test finishes.
 *
 * @param acquired - Acquired runtime, with who loads its models.
 * @returns The same acquisition.
 */
function ownRuntime(acquired: AcquiredLlmRuntime): AcquiredLlmRuntime {
  onTestFinished(async () => await acquired.llmRuntime[Symbol.asyncDispose]())
  return acquired
}

/**
 * Replaces `fetch` with one that answers every request with a JSON body and
 * records each request's URL and `Authorization` header.
 *
 * @param body - JSON body of every answer.
 * @returns The recorded requests, in order.
 */
function stubFetch(body: unknown) {
  const requests: { url: string; authorization: string | null }[] = []
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init.headers).get("authorization")
      })
      return Response.json(body)
    }
  )
  return requests
}

describe("acquireLlmProviderRuntime", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("connects to LM Studio over WebSocket at the saved address", async () => {
    const constructClient = vi.fn()
    fakeLmStudio.operations = { ...fakeLmStudio.operations, constructClient }

    const acquired = ownRuntime(
      await acquireLlmProviderRuntime(
        {
          provider: "lmStudio",
          address: providerAddressSchema.parse("192.168.1.20:1234")
        },
        DISCARDING_SDK_LOGGER
      )
    )

    expect(acquired.llmRuntime).toBeInstanceOf(LmStudioRuntime)
    expect(acquired).toEqual({
      modelLoading: "lys",
      llmRuntime: acquired.llmRuntime,
      llmModelInstanceController: acquired.llmRuntime
    })
    expect(constructClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "ws://192.168.1.20:1234" })
    )
  })

  it("reaches a local Ollama server over HTTP without a key", async () => {
    const server = await startProviderServer({
      "GET /api/tags": answerWith({ models: [] })
    })

    const acquired = ownRuntime(
      await acquireLlmProviderRuntime(
        {
          provider: "ollama",
          mode: "local",
          address: providerAddressSchema.parse(
            server.baseUrl.replace("http://", "")
          )
        },
        DISCARDING_SDK_LOGGER
      )
    )

    expect(acquired.llmRuntime).toBeInstanceOf(OllamaRuntime)
    expect(acquired.modelLoading).toBe("provider")
    expect(server.requests).toEqual([
      {
        method: "GET",
        path: "/api/tags",
        authorization: undefined,
        body: undefined
      }
    ])
  })

  it("reaches Ollama's cloud over HTTPS with the key", async () => {
    const requests = stubFetch({ models: [] })

    const acquired = ownRuntime(
      await acquireLlmProviderRuntime(
        { provider: "ollama", mode: "cloud", apiKey: OLLAMA_KEY },
        DISCARDING_SDK_LOGGER
      )
    )

    expect(acquired.llmRuntime).toBeInstanceOf(OllamaRuntime)
    expect(acquired.modelLoading).toBe("provider")
    expect(requests).toEqual([
      {
        url: "https://ollama.com/api/tags",
        authorization: `Bearer ${OLLAMA_KEY}`
      }
    ])
  })

  it("reaches Groq over HTTPS with the key", async () => {
    const requests = stubFetch({ data: [] })

    const acquired = ownRuntime(
      await acquireLlmProviderRuntime(
        { provider: "groq", apiKey: GROQ_KEY },
        DISCARDING_SDK_LOGGER
      )
    )

    expect(acquired.llmRuntime).toBeInstanceOf(GroqRuntime)
    expect(acquired.modelLoading).toBe("provider")
    expect(requests).toEqual([
      {
        url: "https://api.groq.com/openai/v1/models",
        authorization: `Bearer ${GROQ_KEY}`
      }
    ])
  })
})
