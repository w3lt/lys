import { describe, expect, it } from "vitest"
import {
  MAXIMUM_SEARCH_RESULTS,
  sendTavilySearchRequest,
  sendTavilyUsageRequest
} from "../../../../../../src/modules/tool/builtIn/web/tavilyApi"
import {
  answerWithJson,
  startTavilyServer,
  TEST_TAVILY_API_KEY
} from "../../../../support/tavilyServer"

/**
 * Builds one search result as Tavily sends it.
 *
 * @param index - Distinguishes results.
 * @returns The raw result, with fields Lys does not read.
 */
function buildRawResult(index: number): Record<string, unknown> {
  return {
    title: `Moth ${index}`,
    url: `https://moths.example/${index}`,
    content: `About moth ${index}.`,
    score: 0.9,
    raw_content: null,
    favicon: "https://moths.example/favicon.ico"
  }
}

describe("sendTavilySearchRequest", () => {
  it("asks for a basic search of at most five results with no answer, page text, or images", async () => {
    const server = await startTavilyServer(answerWithJson({ results: [] }))

    await sendTavilySearchRequest(
      { query: "night moths", apiKey: TEST_TAVILY_API_KEY },
      new AbortController().signal,
      server.dependencies
    )

    const [received] = server.receivedRequests
    expect(received?.path).toBe("/search")
    expect(JSON.parse(received?.body ?? "")).toEqual({
      query: "night moths",
      search_depth: "basic",
      max_results: 5,
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false
    })
  })

  it("keeps the first five results when Tavily sends more", async () => {
    const raw = Array.from({ length: 7 }, (_, index) => buildRawResult(index))
    const server = await startTavilyServer(
      answerWithJson({ query: "moths", answer: "LLM text", results: raw })
    )

    const outcome = await sendTavilySearchRequest(
      { query: "moths", apiKey: TEST_TAVILY_API_KEY },
      new AbortController().signal,
      server.dependencies
    )

    const results = outcome.status === "succeeded" ? outcome.results : []
    expect(results).toHaveLength(MAXIMUM_SEARCH_RESULTS)
    expect(results.map((result) => result.title)).toEqual([
      "Moth 0",
      "Moth 1",
      "Moth 2",
      "Moth 3",
      "Moth 4"
    ])
  })

  it.each([
    ["no results field", { answer: "x" }],
    [
      "a result whose title is not text",
      { results: [{ title: 1, url: "u", content: "c" }] }
    ],
    ["a body that is not an object", ["results"]]
  ])("reports %s as an unreadable answer", async (_label, body) => {
    const server = await startTavilyServer(answerWithJson(body))

    const outcome = await sendTavilySearchRequest(
      { query: "moths", apiKey: TEST_TAVILY_API_KEY },
      new AbortController().signal,
      server.dependencies
    )

    expect(outcome).toEqual({
      status: "failed",
      failure: { kind: "unreadable" }
    })
  })

  it("passes on a request failure", async () => {
    const server = await startTavilyServer(answerWithJson({}, 401))

    const outcome = await sendTavilySearchRequest(
      { query: "moths", apiKey: TEST_TAVILY_API_KEY },
      new AbortController().signal,
      server.dependencies
    )

    expect(outcome).toEqual({
      status: "failed",
      failure: {
        kind: "http-status",
        status: 401,
        retryAfterSeconds: undefined
      }
    })
  })
})

describe("sendTavilyUsageRequest", () => {
  it("asks Tavily's usage path with a GET", async () => {
    const server = await startTavilyServer(answerWithJson({ key: {} }))

    await sendTavilyUsageRequest(
      TEST_TAVILY_API_KEY,
      new AbortController().signal,
      server.dependencies
    )

    expect(server.receivedRequests[0]).toMatchObject({
      method: "GET",
      path: "/usage"
    })
  })

  it.each([
    [
      "a fractional usage",
      { plan_usage: 37.5, plan_limit: 1000 },
      { used: 38, limit: 1000 }
    ],
    [
      "a fractional limit",
      { plan_usage: 37, plan_limit: 999.01 },
      { used: 37, limit: 1000 }
    ],
    [
      "a fraction of the first credit, with no limit",
      { plan_usage: 0.2, plan_limit: null },
      { used: 1, limit: null }
    ]
  ])("rounds %s up to a whole credit", async (_label, account, credits) => {
    const server = await startTavilyServer(answerWithJson({ account }))

    const outcome = await sendTavilyUsageRequest(
      TEST_TAVILY_API_KEY,
      new AbortController().signal,
      server.dependencies
    )

    expect(outcome).toEqual({ status: "succeeded", credits })
  })

  it.each([
    ["no account", '{"key":{"usage":3}}'],
    ["an account without plan credits", '{"account":{"current_plan":"x"}}'],
    ["a negative usage", '{"account":{"plan_usage":-0.5,"plan_limit":1000}}'],
    [
      "a usage that is not a number",
      '{"account":{"plan_usage":"37","plan_limit":1000}}'
    ],
    [
      "a usage too large to show exactly",
      '{"account":{"plan_usage":1e300,"plan_limit":null}}'
    ],
    [
      "a usage JSON reads as infinite",
      '{"account":{"plan_usage":1e999,"plan_limit":null}}'
    ]
  ])("accepts an answer with %s, without credits", async (_label, body) => {
    const server = await startTavilyServer(answerWithJson(body))

    const outcome = await sendTavilyUsageRequest(
      TEST_TAVILY_API_KEY,
      new AbortController().signal,
      server.dependencies
    )

    expect(outcome).toEqual({ status: "succeeded", credits: null })
  })

  it("reports a body that is not an object as unreadable", async () => {
    const server = await startTavilyServer(answerWithJson([1, 2]))

    const outcome = await sendTavilyUsageRequest(
      TEST_TAVILY_API_KEY,
      new AbortController().signal,
      server.dependencies
    )

    expect(outcome).toEqual({
      status: "failed",
      failure: { kind: "unreadable" }
    })
  })
})
