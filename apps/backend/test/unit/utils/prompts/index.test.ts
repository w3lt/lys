import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readPrompt } from "../../../../src/utils/prompts"

describe("readPrompt", () => {
  it.each([
    ["lys-system", "lys.txt"],
    ["caliginia", "caliginia.txt"],
    ["lysiptera", "lysiptera.txt"],
    ["title-generation", "title-generation.txt"]
  ] as const)(
    "reads %s from %s without surrounding whitespace",
    (type, fileName) => {
      const fileText = readFileSync(
        new URL(`../../../../src/utils/prompts/${fileName}`, import.meta.url),
        "utf8"
      )

      const prompt = readPrompt(type)

      expect(prompt.length).toBeGreaterThan(0)
      expect(prompt).toBe(prompt.trim())
      expect(fileText).toContain(prompt)
      expect(fileText.replace(prompt, "").trim()).toBe("")
    }
  )
})
