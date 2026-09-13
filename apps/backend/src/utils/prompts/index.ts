import { readFileSync } from "node:fs"

/** Identifiers for prompt files maintained by the backend. */
export type PromptType = "lys-system" | "title-generation"

/** Filesystem record associating a prompt identifier with its module-relative path. */
type PromptProps = {
  /** Stable identifier accepted by {@link readPrompt}. */
  type: PromptType
  /** URL resolved relative to this module and read as UTF-8 text. */
  filePath: URL
}

/** Prompt lookup records used by the explicit prompt-loading boundary. */
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

/**
 * Loads and trims one maintained prompt file.
 *
 * @param type - Prompt identifier whose module-relative file should be read.
 * @returns The prompt text with leading and trailing whitespace removed.
 * @throws If the identifier is not registered or the filesystem read fails.
 */
export const readPrompt = (type: PromptType) => {
  const prompt = prompts.find((p) => p.type === type)
  if (!prompt) throw new Error(`Prompt type ${type} does not exist!`)

  return readFileSync(prompt.filePath, "utf-8").trim()
}
