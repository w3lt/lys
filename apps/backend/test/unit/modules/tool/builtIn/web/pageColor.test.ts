import { describe, expect, it } from "vitest"
import {
  parseCssColor,
  type SrgbColor
} from "../../../../../../src/modules/tool/builtIn/web/pageColor"

/** Most difference, in each channel, a converted color may show. */
const CHANNEL_TOLERANCE = 1

/**
 * Checks a parsed color against the sRGB color it stands for.
 *
 * @param actual - Parsed color, or undefined.
 * @param expected - Channels from 0 to 255 and alpha from 0 to 1.
 */
function expectColorNear(
  actual: SrgbColor | undefined,
  expected: SrgbColor
): void {
  if (actual === undefined) throw new Error("Expected a color")
  for (const channel of ["red", "green", "blue"] as const) {
    expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(
      CHANNEL_TOLERANCE
    )
  }
  expect(actual.alpha).toBeCloseTo(expected.alpha, 6)
}

describe("parseCssColor", () => {
  it.each([
    ["rgb(255, 255, 255)", { red: 255, green: 255, blue: 255, alpha: 1 }],
    ["rgba(0, 0, 0, 0.5)", { red: 0, green: 0, blue: 0, alpha: 0.5 }],
    ["rgb(10 20 30 / 0.25)", { red: 10, green: 20, blue: 30, alpha: 0.25 }],
    ["color(srgb 1 0.5 0)", { red: 255, green: 127.5, blue: 0, alpha: 1 }],
    [
      "color(srgb 1 1 1 / 0.4)",
      { red: 255, green: 255, blue: 255, alpha: 0.4 }
    ],
    [
      "color(srgb-linear 0.5 0.5 0.5)",
      { red: 187.5, green: 187.5, blue: 187.5, alpha: 1 }
    ],
    ["oklch(1 0 0)", { red: 255, green: 255, blue: 255, alpha: 1 }],
    ["oklch(50% 0 0)", { red: 99, green: 99, blue: 99, alpha: 1 }],
    ["oklch(0.5 none 0)", { red: 99, green: 99, blue: 99, alpha: 1 }],
    ["oklch(0 0 0 / 0)", { red: 0, green: 0, blue: 0, alpha: 0 }],
    [
      "oklab(0.627955 0.224863 0.125846)",
      { red: 255, green: 0, blue: 0, alpha: 1 }
    ],
    ["lab(100 0 0)", { red: 255, green: 255, blue: 255, alpha: 1 }],
    ["lab(54.29 80.82 69.88)", { red: 255, green: 0, blue: 0, alpha: 1 }],
    ["lch(54.29 106.84 40.85)", { red: 255, green: 0, blue: 0, alpha: 1 }],
    ["color(display-p3 0 0 0)", { red: 0, green: 0, blue: 0, alpha: 1 }],
    ["color(display-p3 1 1 1)", { red: 255, green: 255, blue: 255, alpha: 1 }],
    [
      "color(xyz-d65 0.95047 1 1.08883)",
      { red: 255, green: 255, blue: 255, alpha: 1 }
    ],
    [
      "color(xyz-d50 0.96422 1 0.82521)",
      { red: 255, green: 255, blue: 255, alpha: 1 }
    ]
  ])("converts %s to sRGB", (value, expected) => {
    expectColorNear(parseCssColor(value), expected)
  })

  it("clips a color outside sRGB to its nearest channels", () => {
    expectColorNear(parseCssColor("color(display-p3 1 0 0)"), {
      red: 255,
      green: 0,
      blue: 0,
      alpha: 1
    })
  })

  it.each([
    "",
    "currentcolor",
    "color(rec2020 1 1 1)",
    "rgb(1, 2)",
    "oklch(1 0)",
    "lab(moth 0 0)",
    "rgb(1, 2, 3, 4, 5)"
  ])("cannot convert %j", (value) => {
    expect(parseCssColor(value)).toBeUndefined()
  })
})
