import * as z from "zod"

/**
 * Inclusive maximum length of an agent code, in UTF-16 code units.
 *
 * @remarks Enforced on every code the API accepts and on every stored code;
 * the backend also cuts the codes it derives from agent names to this length.
 * Lowering it can make stored agents unreadable.
 */
export const MAXIMUM_AGENT_CODE_LENGTH = 64

/** Inclusive maximum length of a trimmed agent name, in UTF-16 code units. */
const MAXIMUM_AGENT_NAME_LENGTH = 64

/** Inclusive maximum length of a trimmed agent bio, in UTF-16 code units. */
const MAXIMUM_AGENT_BIO_LENGTH = 128

/**
 * Lowercase ASCII letters and digits in hyphen-separated groups, with no
 * leading, trailing, or doubled hyphen.
 */
const AGENT_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Validates an ISO-8601 timestamp with exactly millisecond precision. */
const agentTimestampSchema = z.iso.datetime({ precision: 3 })

/**
 * Validates an agent code, the agent's immutable identity: a lowercase slug
 * such as `lys` or `web-researcher`. Codes are compared exactly and never
 * trimmed or case-folded.
 *
 * @remarks Shared by stored agents, new agent definitions, and the path
 * parameter of the agent endpoints.
 */
export const agentCodeSchema = z
  .string()
  .max(MAXIMUM_AGENT_CODE_LENGTH)
  .regex(AGENT_CODE_PATTERN)

/**
 * Answers whether a text has no leading or trailing whitespace.
 *
 * @param text - Text to inspect.
 * @returns True when trimming would not change the text.
 */
function isTrimmedText(text: string): boolean {
  return text.trim() === text
}

/** Failure reported for stored text that still has surrounding whitespace. */
const UNTRIMMED_AGENT_TEXT_MESSAGE =
  "Agent text must not start or end with whitespace."

/** Validates a stored display name: non-empty, trimmed, and bounded. */
const storedAgentNameSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_AGENT_NAME_LENGTH)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)

/** Validates a stored short description: non-empty, trimmed, and bounded. */
const storedAgentBioSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_AGENT_BIO_LENGTH)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)

/** Validates a stored system prompt: non-empty and trimmed, of any length. */
const storedAgentSystemPromptSchema = z
  .string()
  .min(1)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)

/** Trims a candidate display name, then validates it as stored. */
const agentNameSchema = z.string().trim().pipe(storedAgentNameSchema)

/** Trims a candidate short description, then validates it as stored. */
const agentBioSchema = z.string().trim().pipe(storedAgentBioSchema)

/** Trims a candidate system prompt, then validates it as stored. */
const agentSystemPromptSchema = z
  .string()
  .trim()
  .pipe(storedAgentSystemPromptSchema)

/**
 * Validates the definition of a new agent. The output has its name, bio, and
 * system prompt trimmed and is frozen; unknown fields are rejected.
 *
 * @remarks `code` is optional: a given code is kept exactly, and when it is
 * omitted the backend derives one from the name.
 */
export const agentDefinitionSchema = z
  .strictObject({
    code: agentCodeSchema.optional(),
    name: agentNameSchema,
    bio: agentBioSchema,
    systemPrompt: agentSystemPromptSchema
  })
  .readonly()

/**
 * Candidate definition of a new agent, before {@link agentDefinitionSchema}
 * validates and trims it.
 */
export type AgentDefinitionCandidate = z.input<typeof agentDefinitionSchema>

/** Validated definition of a new agent, its text trimmed. */
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

/**
 * Validates a stored agent: its definition with the times it was created and
 * last changed. Stored text is checked as it is, never trimmed, so a value
 * with surrounding whitespace is rejected. The output is frozen; unknown
 * fields are rejected.
 */
export const agentSchema = z
  .strictObject({
    code: agentCodeSchema,
    name: storedAgentNameSchema,
    bio: storedAgentBioSchema,
    systemPrompt: storedAgentSystemPromptSchema,
    createdAt: agentTimestampSchema,
    updatedAt: agentTimestampSchema
  })
  .readonly()

/**
 * Stored agent definition.
 *
 * @remarks `createdAt` is set once when the agent is stored. `updatedAt`
 * equals it until the first update and then holds the time of the latest one.
 */
export type Agent = z.infer<typeof agentSchema>

/**
 * Validates a change to one stored agent. Each field present replaces the
 * stored value, trimmed; an omitted or undefined field keeps it. At least one
 * field must be present. The output is frozen; unknown fields are rejected,
 * including `code`: a change never alters the agent's code.
 */
export const agentChangesSchema = z
  .strictObject({
    name: agentNameSchema.optional(),
    bio: agentBioSchema.optional(),
    systemPrompt: agentSystemPromptSchema.optional()
  })
  .refine(
    (changes) =>
      changes.name !== undefined ||
      changes.bio !== undefined ||
      changes.systemPrompt !== undefined,
    { message: "An agent change must change at least one field." }
  )
  .readonly()

/**
 * Candidate change to one stored agent, before {@link agentChangesSchema}
 * validates and trims it.
 */
export type AgentChangesCandidate = z.input<typeof agentChangesSchema>

/**
 * Validated change to one stored agent. Applying the same change again stores
 * the same values; only the time of the change moves.
 */
export type AgentChanges = z.infer<typeof agentChangesSchema>
