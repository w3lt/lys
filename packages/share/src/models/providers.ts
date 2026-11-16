import * as z from "zod"
import { isHostName, MAXIMUM_TCP_PORT } from "./hostName"

/**
 * Most characters a provider address may have, inclusive: a 253-character
 * host name, a colon, and a five-digit port.
 */
const MAXIMUM_PROVIDER_ADDRESS_LENGTH = 259

/** Finds a decimal port without a leading zero. */
const PORT_PATTERN = /^[1-9]\d{0,4}$/

/**
 * Validates a model provider: `lmStudio`, a server the person runs;
 * `ollama`, a local Ollama server the person runs; `ollamaCloud`, Ollama's
 * hosted service, reached with an API key; or `groq`, Groq's hosted API,
 * reached with an API key.
 *
 * @remarks The values are in provider order, the order Lys lists and saves
 * providers in. Persisted in the settings file's `providers.enabled` list, in
 * each stored reply, and sent in model routes and chat requests. The desktop
 * host declares the same four values. Removing or renaming one changes which
 * settings files and databases load and requires a coordinated desktop and
 * backend release.
 */
export const llmProviderSchema = z.enum([
  "lmStudio",
  "ollama",
  "ollamaCloud",
  "groq"
])

/** A model provider Lys can reach. */
export type LlmProvider = z.infer<typeof llmProviderSchema>

/** Every provider, in provider order. */
export const LLM_PROVIDERS: readonly LlmProvider[] = Object.freeze([
  ...llmProviderSchema.options
])

/** Name of each provider, as the person reads it. */
export const LLM_PROVIDER_NAMES = Object.freeze({
  lmStudio: "LM Studio",
  ollama: "Ollama",
  ollamaCloud: "Ollama Cloud",
  groq: "Groq"
} satisfies Readonly<Record<LlmProvider, string>>)

/**
 * Validates one model on one provider: the provider, and the key that
 * provider lists the model under.
 *
 * @remarks The same key on two providers names two models, so a model is
 * never named by its key alone. Sent in chat requests; the key is not
 * checked against the provider's list here.
 */
export const llmModelReferenceSchema = z
  .strictObject({
    /** Provider that serves the model. */
    provider: llmProviderSchema,
    /** Key the provider lists the model under; non-empty. */
    modelKey: z.string().min(1)
  })
  .readonly()

/** One model on one provider. */
export type LlmModelReference = z.infer<typeof llmModelReferenceSchema>

/**
 * Answers whether two references name the same model.
 *
 * @param left - First reference.
 * @param right - Second reference.
 * @returns True when the provider and the key are both equal.
 */
export function isSameLlmModelReference(
  left: LlmModelReference,
  right: LlmModelReference
): boolean {
  return left.provider === right.provider && left.modelKey === right.modelKey
}

/**
 * Answers whether a text follows the provider address rule: a host name or
 * dotted IPv4 address, a colon, and a port from 1 to 65535.
 *
 * @param value - Text to inspect, as typed.
 * @returns True when the text is a valid provider address.
 * @remarks The host is 1 to 253 characters of labels separated by dots; each
 * label is 1 to 63 letters, digits, or inner hyphens. A scheme, path, user
 * name, or IPv6 address is not an address here.
 */
function isProviderAddress(value: string): boolean {
  if (value.length > MAXIMUM_PROVIDER_ADDRESS_LENGTH) return false
  const separator = value.lastIndexOf(":")
  if (separator <= 0) return false
  const host = value.slice(0, separator)
  const port = value.slice(separator + 1)
  return isHostName(host) && isTcpPort(port)
}

/**
 * Answers whether a text is a TCP port under the provider address rule.
 *
 * @param port - Port part of an address.
 * @returns True for a decimal number from 1 to 65535 without a leading zero.
 */
function isTcpPort(port: string): boolean {
  return PORT_PATTERN.test(port) && Number(port) <= MAXIMUM_TCP_PORT
}

/**
 * Validates the address of a provider server the person runs, such as
 * `127.0.0.1:1234`: a host name or IPv4 address and a port.
 *
 * @remarks The rule matches the desktop host's `ProviderAddress`. Parsing
 * never trims or changes the text. The address may name another machine;
 * requests to it use plain HTTP. The output is branded, so a checked address
 * cannot stand in for other text.
 */
export const providerAddressSchema = z
  .string()
  .refine(
    isProviderAddress,
    "An address is a host name or IPv4 address, a colon, and a port from 1 to 65535, such as 127.0.0.1:1234."
  )
  .brand<"ProviderAddress">()

/** Provider address that passed {@link providerAddressSchema}. */
export type ProviderAddress = z.infer<typeof providerAddressSchema>

/**
 * Answers whether a list names each provider at most once.
 *
 * @param providers - Providers to inspect.
 * @returns True when no provider appears twice.
 */
function hasDistinctProviders(providers: readonly LlmProvider[]): boolean {
  return new Set(providers).size === providers.length
}

/**
 * Validates the providers that are on and the server addresses saved in the
 * settings file's `providers` group.
 *
 * @remarks A `null` address means the provider's default address, which
 * `@lys/protocol` owns, so the file never holds a copy of a default. API keys
 * are not here: they live in the `secrets` group. The desktop host reads a
 * file saved before several providers could be on, which names one `active`
 * provider instead of `enabled`, as that one provider on; this schema sees
 * the document after that reading.
 */
export const llmProviderSettingsSchema = z
  .strictObject({
    /**
     * Providers that are on, each once, in any order; empty when none is.
     * Every provider that is on answers requests for its own models.
     */
    enabled: z
      .array(llmProviderSchema)
      .readonly()
      .refine(hasDistinctProviders, "A provider is listed more than once."),
    /** LM Studio's server. */
    lmStudio: z
      .strictObject({
        /** Address of LM Studio's server, or null for its default. */
        address: providerAddressSchema.nullable()
      })
      .readonly(),
    /** The local Ollama server; Ollama Cloud needs no address. */
    ollama: z
      .strictObject({
        /** Address of the local Ollama server, or null for its default. */
        address: providerAddressSchema.nullable()
      })
      .readonly()
  })
  .readonly()

/** Providers that are on and server addresses saved in the settings file. */
export type LlmProviderSettings = z.infer<typeof llmProviderSettingsSchema>
