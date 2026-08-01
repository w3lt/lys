import { readFileSync } from "node:fs"

export type PromptType = "lys-system" | "title-generation"
type PromptProps = {
  type: PromptType
  filePath: URL
}

const prompts: PromptProps[] = [
  {
    type: "lys-system",
    filePath: new URL("./lys.txt", import.meta.url)
  },
  {
    type: "title-generation",
    filePath: new URL("./title-generation.txt", import.meta.url)
  }
]

export const readPrompt = (type: PromptType) => {
  const prompt = prompts.find((p) => p.type === type)
  if (!prompt) throw new Error(`Prompt type ${type} does not exist!`)

  return readFileSync(prompt.filePath, "utf-8").trim()
}

export const lysSystemPrompt = () => readPrompt("lys-system")
export const titleGenerationPrompt = () => readPrompt("title-generation")
