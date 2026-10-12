import { describe, expect, it } from "vitest"
import {
  calculateContextUsage,
  estimateAttachmentTokens,
  estimateTextTokens,
  formatTokenCount,
  type ComposerAttachment,
  type ContextTurn
} from "@/components/ComposerComponents/composer-context"

/**
 * Builds one conversation turn whose text is a run of one character.
 *
 * @param id - Turn identity.
 * @param length - Text length in UTF-16 code units; at the estimator's 3.7
 * characters per token, the cases use lengths that estimate to whole
 * hundreds or tens of tokens.
 * @returns The turn.
 */
function buildTurn(id: string, length: number): ContextTurn {
  return { id, text: "x".repeat(length) }
}

/**
 * Builds one staged attachment with a fixed estimated cost.
 *
 * @param id - Attachment identity.
 * @param estimatedTokens - Estimated tokens the file occupies.
 * @returns The attachment.
 */
function buildAttachment(
  id: string,
  estimatedTokens: number
): ComposerAttachment {
  return { id, name: `${id}.txt`, kind: "txt", estimatedTokens }
}

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
  it("spends only the backend preamble on an empty conversation", () => {
    const usage = calculateContextUsage({
      budget: 8192,
      reserve: 1024,
      turns: [],
      attachments: []
    })

    expect(usage).toEqual({
      budget: 8192,
      reserve: 1024,
      systemTokens: 96,
      attachmentTokens: 0,
      recapTokens: 0,
      keptTokens: 0,
      usedTokens: 96,
      overflowTokens: 0,
      freeTokens: 7072,
      keptTurnCount: 0,
      compactedTurnCount: 0,
      keptTurnIds: new Set(),
      filledFraction: (96 + 1024) / 8192
    })
  })

  it("keeps every turn verbatim while they fit", () => {
    const usage = calculateContextUsage({
      budget: 8192,
      reserve: 1024,
      turns: [buildTurn("first", 37), buildTurn("second", 74)],
      attachments: []
    })

    expect(usage).toMatchObject({
      keptTokens: 30,
      usedTokens: 126,
      freeTokens: 7042,
      keptTurnCount: 2,
      compactedTurnCount: 0,
      recapTokens: 0,
      keptTurnIds: new Set(["first", "second"])
    })
  })

  it("keeps the newest turns that fit and bills the minimum recap for the rest", () => {
    // Room for turns: 1000 - 96 = 904. Newest first: 500 + 300 fit, the
    // 200-token oldest turn does not; its recap costs the 48-token minimum.
    const usage = calculateContextUsage({
      budget: 1000,
      reserve: 0,
      turns: [
        buildTurn("oldest", 740),
        buildTurn("middle", 1110),
        buildTurn("newest", 1850)
      ],
      attachments: []
    })

    expect(usage).toMatchObject({
      keptTokens: 800,
      recapTokens: 48,
      usedTokens: 944,
      freeTokens: 56,
      overflowTokens: 0,
      keptTurnCount: 2,
      compactedTurnCount: 1,
      keptTurnIds: new Set(["middle", "newest"]),
      filledFraction: 0.944
    })
  })

  it("compacts every turn older than the first one that does not fit", () => {
    // The 900-token middle turn does not fit beside the newest; the 10-token
    // oldest turn would fit on its own but the window stays contiguous.
    const usage = calculateContextUsage({
      budget: 1000,
      reserve: 0,
      turns: [
        buildTurn("oldest", 37),
        buildTurn("middle", 3330),
        buildTurn("newest", 1850)
      ],
      attachments: []
    })

    expect(usage).toMatchObject({
      keptTurnIds: new Set(["newest"]),
      keptTurnCount: 1,
      compactedTurnCount: 2,
      recapTokens: 146,
      usedTokens: 742
    })
  })

  it("pays for the recap from the room for turns, which can push another turn out", () => {
    // 500 + 380 fit the 904 tokens of room, but the 48-token recap of the
    // oldest turn leaves 856, so the 380-token turn is compacted as well.
    const usage = calculateContextUsage({
      budget: 1000,
      reserve: 0,
      turns: [
        buildTurn("oldest", 740),
        buildTurn("middle", 1406),
        buildTurn("newest", 1850)
      ],
      attachments: []
    })

    expect(usage).toMatchObject({
      keptTurnIds: new Set(["newest"]),
      compactedTurnCount: 2,
      recapTokens: 93,
      usedTokens: 689,
      freeTokens: 311,
      overflowTokens: 0
    })
  })

  it("bills attachments in full and never compacts them", () => {
    const usage = calculateContextUsage({
      budget: 1000,
      reserve: 0,
      turns: [buildTurn("only", 1480)],
      attachments: [buildAttachment("notes", 600)]
    })

    expect(usage).toMatchObject({
      attachmentTokens: 600,
      keptTurnCount: 0,
      compactedTurnCount: 1,
      recapTokens: 64,
      usedTokens: 760,
      overflowTokens: 0
    })
  })

  it("reports how far one large attachment overflows the window and clamps the fill", () => {
    const usage = calculateContextUsage({
      budget: 1000,
      reserve: 200,
      turns: [],
      attachments: [
        buildAttachment("small", 100),
        buildAttachment("large", 800)
      ]
    })

    expect(usage).toMatchObject({
      attachmentTokens: 900,
      usedTokens: 996,
      overflowTokens: 196,
      freeTokens: 0,
      filledFraction: 1
    })
  })

  it("counts the reply reserve against the window", () => {
    const withoutReserve = calculateContextUsage({
      budget: 1000,
      reserve: 0,
      turns: [buildTurn("only", 370)],
      attachments: []
    })
    const withReserve = calculateContextUsage({
      budget: 1000,
      reserve: 400,
      turns: [buildTurn("only", 370)],
      attachments: []
    })

    expect(withoutReserve.freeTokens).toBe(804)
    expect(withReserve.freeTokens).toBe(404)
    expect(withReserve.filledFraction).toBe(0.596)
  })
})
