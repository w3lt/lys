import { describe, expect, it } from "vitest"
import {
  buildContextMeterState,
  calculateContextUsage,
  estimateAttachmentTokens,
  estimateTextTokens,
  formatTokenCount
} from "@/components/ComposerComponents/composer-context"

/** Measurement of a conversation with four earlier messages. */
const MEASUREMENT = Object.freeze({
  contextLength: 8192,
  systemPromptTokens: 2260,
  toolTokens: 410,
  historyTokens: 1000,
  historyMessageCount: 4,
  messageMarkupTokens: 8
})

describe("estimateTextTokens", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["x".repeat(36), 10],
    ["x".repeat(38), 11],
    ["x".repeat(370), 100]
  ])("estimates %j as %d tokens, rounding up", (text, tokens) => {
    expect(estimateTextTokens(text)).toBe(tokens)
  })
})

describe("estimateAttachmentTokens", () => {
  it.each([
    [0, 1],
    [1, 1],
    [4, 1],
    [5, 2],
    [4000, 1000]
  ])("estimates a %d-byte file as %d tokens", (sizeBytes, tokens) => {
    expect(estimateAttachmentTokens(sizeBytes)).toBe(tokens)
  })
})

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [812, "812"],
    [999, "999"],
    [1000, "1.0k"],
    [4100, "4.1k"],
    [10_000, "10k"],
    [16_384, "16k"]
  ])("formats %d tokens as %s", (tokenCount, label) => {
    expect(formatTokenCount(tokenCount)).toBe(label)
  })
})

describe("calculateContextUsage", () => {
  it("adds the draft's estimate and the markup around it to the measured parts and keeps the reply reserve free", () => {
    const usage = calculateContextUsage({
      measurement: MEASUREMENT,
      draft: "x".repeat(370),
      reserve: 2048
    })

    expect(usage).toEqual({
      contextLength: 8192,
      reserve: 2048,
      systemPromptTokens: 2260,
      toolTokens: 410,
      historyTokens: 1000,
      historyMessageCount: 4,
      messageTokens: 108,
      usedTokens: 3778,
      overflowTokens: 0,
      freeTokens: 2366,
      filledFraction: (3778 + 2048) / 8192
    })
  })

  it("estimates the draft as it is sent, without surrounding whitespace", () => {
    const usage = calculateContextUsage({
      measurement: MEASUREMENT,
      draft: "  \n" + "x".repeat(37) + "\n  ",
      reserve: 0
    })

    expect(usage.messageTokens).toBe(18)
  })

  it("refuses a short draft that fits only without the markup around the new message", () => {
    const reserve = 8192 - 2260 - 410 - 1000 - 3

    const usage = calculateContextUsage({
      measurement: MEASUREMENT,
      draft: "Thanks!",
      reserve
    })

    expect(usage).toMatchObject({ messageTokens: 10, overflowTokens: 7 })
  })

  it("fits a request that takes exactly the whole window with the reserve", () => {
    const usage = calculateContextUsage({
      measurement: MEASUREMENT,
      draft: "",
      reserve: 8192 - 2260 - 410 - 1000 - 8
    })

    expect(usage).toMatchObject({
      overflowTokens: 0,
      freeTokens: 0,
      filledFraction: 1
    })
  })

  it("reports how far the request and the reserve exceed the window and clamps the fill", () => {
    const usage = calculateContextUsage({
      measurement: MEASUREMENT,
      draft: "x".repeat(370),
      reserve: 5000
    })

    expect(usage).toMatchObject({
      usedTokens: 3778,
      overflowTokens: 3778 + 5000 - 8192,
      freeTokens: 0,
      filledFraction: 1
    })
  })
})

describe("buildContextMeterState", () => {
  it("is measuring before the first measurement settles", () => {
    expect(
      buildContextMeterState(undefined, { draft: "Hi", reserve: 0 })
    ).toEqual({ status: "measuring" })
  })

  it("breaks a measurement down with the draft and the reserve", () => {
    expect(
      buildContextMeterState(
        { status: "measured", measurement: MEASUREMENT },
        { draft: "x".repeat(37), reserve: 2048 }
      )
    ).toEqual({
      status: "measured",
      usage: calculateContextUsage({
        measurement: MEASUREMENT,
        draft: "x".repeat(37),
        reserve: 2048
      })
    })
  })

  it("says the window is unknown when the model is not loaded", () => {
    expect(
      buildContextMeterState(
        { status: "model-not-loaded" },
        { draft: "", reserve: 0 }
      )
    ).toEqual({
      status: "unknown",
      reason: "LM Studio has not loaded the model, so the window is unknown."
    })
  })

  it("passes the failure's sentence on when the measurement failed", () => {
    expect(
      buildContextMeterState(
        { status: "failed", message: "The backend could not be reached." },
        { draft: "", reserve: 0 }
      )
    ).toEqual({
      status: "unknown",
      reason: "The backend could not be reached."
    })
  })
})
