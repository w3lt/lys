import * as z from "zod"

/**
 * Most characters a provider address may have, inclusive: a 253-character
 * host name, a colon, and a five-digit port.
 */
const MAXIMUM_PROVIDER_ADDRESS_LENGTH = 259

/** Highest TCP port number, inclusive. */
const MAXIMUM_TCP_PORT = 65_535

/** Most characters one host name label may have, inclusive. */
const MAXIMUM_HOST_LABEL_LENGTH = 63

/** Most characters a host name may have, inclusive. */
const MAXIMUM_HOST_NAME_LENGTH = 253

/**
 * Finds one host name label: letters, digits, and inner hyphens, which also
 * covers each part of a dotted IPv4 address.
 */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

/** Finds a decimal port without a leading zero. */
const PORT_PATTERN = /^[1-9]\d{0,4}$/

/**
 * Validates which model provider every request goes to.
 *
 * @remarks Persisted in the settings file's `providers` group as `active`.
 * The desktop host declares the same three values. Removing or renaming one
 * changes which settings files load and requires a coordinated desktop and
 * backend release.
 */
export const llmProviderSchema = z.enum(["lmStudio", "ollama", "groq"])

/** Model provider every request goes to. */
export type LlmProvider = z.infer<typeof llmProviderSchema>

/**
 * Validates where Ollama runs: `local`, a server the person names, or
 * `cloud`, Ollama's hosted service, which needs an API key.
 *
 * @remarks Persisted in the settings file's `providers.ollama` group as
 * `mode`; the desktop host declares the same two values.
 */
export const ollamaModeSchema = z.enum(["local", "cloud"])

/** Where Ollama runs. */
export type OllamaMode = z.infer<typeof ollamaModeSchema>

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
 * Answers whether a text is a host name under the provider address rule.
 *
 * @param host - Host part of an address.
 * @returns True for 1 to 253 characters of valid labels separated by dots.
 */
function isHostName(host: string): boolean {
  if (host.length > MAXIMUM_HOST_NAME_LENGTH) return false
  return host
    .split(".")
    .every(
      (label) =>
        label.length <= MAXIMUM_HOST_LABEL_LENGTH &&
        HOST_LABEL_PATTERN.test(label)
    )
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
 * Validates the provider choice and server addresses saved in the settings
 * file's `providers` group.
 *
 * @remarks A `null` address means the provider's default address, which
 * `@lys/protocol` owns, so the file never holds a copy of a default. API keys
 * are not here: they live in the `secrets` group.
 */
export const llmProviderSettingsSchema = z
  .strictObject({
    /** Provider every request goes to. */
    active: llmProviderSchema,
    /** LM Studio's server. */
    lmStudio: z
      .strictObject({
        /** Address of LM Studio's server, or null for its default. */
        address: providerAddressSchema.nullable()
      })
      .readonly(),
    /** Ollama's mode and local server. */
    ollama: z
      .strictObject({
        /** Whether requests go to a local server or to Ollama's cloud. */
        mode: ollamaModeSchema,
        /**
         * Address of the local Ollama server, or null for its default; kept,
         * but unused, while the mode is `cloud`.
         */
        address: providerAddressSchema.nullable()
      })
      .readonly()
  })
  .readonly()

/** Provider choice and server addresses saved in the settings file. */
export type LlmProviderSettings = z.infer<typeof llmProviderSettingsSchema>
