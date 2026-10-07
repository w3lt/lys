import * as z from "zod"

/**
 * Inclusive maximum length of an agent code, in UTF-16 code units, which are
 * also characters because codes are ASCII.
 *
 * @remarks Enforced on every code the API accepts and on every stored code;
 * the backend also cuts the codes it derives from agent names to this length.
 * Codes up to this length are transmitted in agent paths and bodies and
 * persisted as agent identities, so clients may rely on the value. Raising it
 * keeps stored agents readable, but clients built with the old value reject
 * the longer codes; lowering it makes stored agents with longer codes
 * unreadable.
 */
export const MAXIMUM_AGENT_CODE_LENGTH = 64

/**
 * Inclusive maximum length of a trimmed agent name, in UTF-16 code units.
 *
 * @remarks Enforced on every name the API accepts and on every stored name;
 * clients use it to bound name entry. Raising it keeps stored agents
 * readable, but clients built with the old value reject the longer names;
 * lowering it makes stored agents with longer names unreadable.
 */
export const MAXIMUM_AGENT_NAME_LENGTH = 64

/**
 * Inclusive maximum length of a trimmed agent bio, in UTF-16 code units.
 *
 * @remarks Enforced on every bio the API accepts and on every stored bio;
 * clients use it to bound bio entry. Raising it keeps stored agents readable,
 * but clients built with the old value reject the longer bios; lowering it
 * makes stored agents with longer bios unreadable.
 */
export const MAXIMUM_AGENT_BIO_LENGTH = 128

/**
 * Code of Lys, the agent the backend ships with.
 *
 * @remarks Clients send it to start a conversation that Lys answers, and the
 * backend reserves it, so no stored agent can be created under it. The
 * backend stores it on the conversations Lys answers; its schema version 7
 * recorded it on every earlier conversation. Changing it orphans those
 * conversations, so it stays fixed across releases.
 */
export const LYS_AGENT_CODE = "lys"

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

/** Matches a UTF-16 surrogate code unit that is not part of a pair. */
const LONE_SURROGATE_PATTERN = /\p{Cs}/u

/**
 * Answers whether a text is well-formed UTF-16, every surrogate paired.
 *
 * @param text - Text to inspect.
 * @returns True when the text has no lone surrogate, so encoding it as UTF-8
 * for storage or transmission keeps it unchanged.
 */
function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE_PATTERN.test(text)
}

/** Failure reported for text that UTF-8 cannot carry unchanged. */
const ILL_FORMED_AGENT_TEXT_MESSAGE =
  "Agent text must not contain a lone surrogate."

/**
 * Validates a stored display name: non-empty, trimmed, well-formed, and
 * bounded.
 */
const storedAgentNameSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_AGENT_NAME_LENGTH)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)
  .refine(isWellFormedText, ILL_FORMED_AGENT_TEXT_MESSAGE)

/**
 * Validates a stored short description: non-empty, trimmed, well-formed, and
 * bounded.
 */
const storedAgentBioSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_AGENT_BIO_LENGTH)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)
  .refine(isWellFormedText, ILL_FORMED_AGENT_TEXT_MESSAGE)

/**
 * Validates a stored system prompt: non-empty, trimmed, and well-formed, of
 * any length.
 */
const storedAgentSystemPromptSchema = z
  .string()
  .min(1)
  .refine(isTrimmedText, UNTRIMMED_AGENT_TEXT_MESSAGE)
  .refine(isWellFormedText, ILL_FORMED_AGENT_TEXT_MESSAGE)

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
    /** Code to store the agent under; omitted to derive one from the name. */
    code: agentCodeSchema.optional(),
    /** Display name; names need not be unique. */
    name: agentNameSchema,
    /** Short description of what the agent does. */
    bio: agentBioSchema,
    /** System prompt that defines the agent's behavior. */
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
    /** Immutable identity of the agent, compared exactly. */
    code: agentCodeSchema,
    /** Display name; names need not be unique. */
    name: storedAgentNameSchema,
    /** Short description of what the agent does. */
    bio: storedAgentBioSchema,
    /** System prompt that defines the agent's behavior. */
    systemPrompt: storedAgentSystemPromptSchema,
    /** Time the agent was stored; it never changes. */
    createdAt: agentTimestampSchema,
    /** Time of the latest change; equals `createdAt` until the first one. */
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
    /** Replacement display name; omitted or undefined to keep it. */
    name: agentNameSchema.optional(),
    /** Replacement short description; omitted or undefined to keep it. */
    bio: agentBioSchema.optional(),
    /** Replacement system prompt; omitted or undefined to keep it. */
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
