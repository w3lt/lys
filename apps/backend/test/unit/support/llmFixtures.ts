import type { LLMInfo } from "@lmstudio/sdk"
import type { DownloadedLlmModel } from "../../../src/modules/llm/llmRuntimeTypes"

/** Identity fields that distinguish one fixture model from another. */
export type LlmModelFixtureIdentity = Readonly<{
  /** Canonical model key. */
  modelKey: string
  /** Relative model path; defaults to `<modelKey>/model.gguf`. */
  path?: string
}>

/**
 * Creates valid normalized runtime metadata for one downloaded model.
 *
 * @param identity - Key and optional path distinguishing the model.
 * @returns Frozen metadata with fixed, schema-valid descriptive fields and no
 * optional metadata.
 */
export function createDownloadedLlmModel(
  identity: LlmModelFixtureIdentity
): DownloadedLlmModel {
  return Object.freeze({
    modelKey: identity.modelKey,
    format: "gguf",
    displayName: `Display ${identity.modelKey}`,
    path: identity.path ?? `${identity.modelKey}/model.gguf`,
    sizeBytes: 4096,
    vision: false,
    trainedForToolUse: false,
    maxContextLength: 8192
  })
}

/**
 * Creates the vendor record LM Studio reports for one downloaded LLM.
 *
 * @param identity - Key and optional path distinguishing the model.
 * @returns A complete SDK `LLMInfo` value for a model on this machine: the
 * vendor `type` discriminator, the vendor fields the application does not
 * consume, and the optional parameter, architecture, and quantization
 * metadata. The optional variant fields are absent.
 */
export function createLmStudioLlmRecord(
  identity: LlmModelFixtureIdentity
): LLMInfo {
  return {
    ...createDownloadedLlmModel(identity),
    type: "llm",
    publisher: "fixture-publisher",
    indexedModelIdentifier: `fixture-publisher/${identity.modelKey}`,
    deviceIdentifier: null,
    paramsString: "7B",
    architecture: "llama",
    quantization: { name: "Q4_K_M", bits: 4 }
  }
}
