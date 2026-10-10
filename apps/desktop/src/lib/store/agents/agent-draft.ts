import {
  agentCodeSchema,
  MAXIMUM_AGENT_BIO_LENGTH,
  MAXIMUM_AGENT_CODE_LENGTH,
  MAXIMUM_AGENT_NAME_LENGTH,
  type Agent
} from "@lys/share"

/**
 * Identity of one listed agent, built-in or the user's own, against which a
 * draft's name and code are checked.
 */
export type ListedAgentIdentity = {
  /** Code of the listed agent. */
  readonly code: string
  /** Display name of the listed agent. */
  readonly name: string
}

/**
 * Editable text of one agent, exactly as typed.
 *
 * @remarks Values are untrimmed; saving trims them. A draft for a stored
 * agent starts as that agent's stored text.
 */
export type AgentDraft = {
  /** Display name as typed. */
  readonly name: string
  /** One-line description as typed. */
  readonly bio: string
  /** System prompt as typed. */
  readonly systemPrompt: string
}

/** Agent a draft is written for, which decides the checks that apply. */
export type AgentDraftSubject =
  | {
      /** The draft creates an agent. */
      readonly kind: "new"
      /** Code typed for it; empty asks the backend to derive one. */
      readonly code: string
    }
  | {
      /** The draft changes a stored agent. */
      readonly kind: "stored"
      /** Code of that agent, which never changes. */
      readonly code: string
      /**
       * Name of that agent as stored; keeping it never counts as taken, even
       * when another agent has the same name.
       */
      readonly name: string
    }

/**
 * First reason a draft cannot be saved, in field order: name, code, bio,
 * system prompt.
 */
export type AgentDraftProblem =
  | {
      /** The name is blank. */
      readonly kind: "name-missing"
    }
  | {
      /** The trimmed name is longer than the shared maximum. */
      readonly kind: "name-too-long"
    }
  | {
      /** Another agent already has the name, compared case-insensitively. */
      readonly kind: "name-taken"
      /** The name as typed, trimmed. */
      readonly name: string
    }
  | {
      /** The typed code is not a valid agent code. */
      readonly kind: "code-malformed"
    }
  | {
      /** Another listed agent already has the typed code. */
      readonly kind: "code-taken"
      /** The typed code. */
      readonly code: string
    }
  | {
      /** The bio is blank. */
      readonly kind: "bio-missing"
    }
  | {
      /** The trimmed bio is longer than the shared maximum. */
      readonly kind: "bio-too-long"
    }
  | {
      /** The system prompt is blank. */
      readonly kind: "system-prompt-missing"
    }

/** Editor field that a draft problem concerns. */
export type AgentDraftField = "name" | "code" | "bio" | "systemPrompt"

/** Draft of a new agent before anything is typed. */
export const EMPTY_AGENT_DRAFT: AgentDraft = Object.freeze({
  name: "",
  bio: "",
  systemPrompt: ""
})

/**
 * Calculates the form under which names are compared for uniqueness.
 *
 * @param name - Name as typed or stored.
 * @returns The name trimmed and lowercased.
 */
function calculateComparableAgentName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Reports whether a listed agent is the stored agent a draft edits.
 *
 * @param agent - Listed agent.
 * @param subject - Agent the draft is written for.
 * @returns Whether the draft edits that listed agent; never for a new agent.
 */
function isDraftSubject(
  agent: ListedAgentIdentity,
  subject: AgentDraftSubject
): boolean {
  return subject.kind === "stored" && agent.code === subject.code
}

/**
 * Reports whether a draft keeps the name its stored agent already has.
 *
 * @param comparableName - Draft name in its comparable form.
 * @param subject - Agent the draft is written for.
 * @returns Whether a stored agent keeps its stored name, compared
 * case-insensitively; never for a new agent.
 */
function isStoredAgentNameKept(
  comparableName: string,
  subject: AgentDraftSubject
): boolean {
  return (
    subject.kind === "stored" &&
    calculateComparableAgentName(subject.name) === comparableName
  )
}

/**
 * Finds the name problem of a draft.
 *
 * @param name - Name as typed.
 * @param subject - Agent the draft is written for; a stored agent's own name
 * never counts as taken, so agents that already share a name stay editable.
 * @param agents - Every listed agent.
 * @returns The name problem, or undefined when the name can be saved. The
 * trimmed name is measured in UTF-16 code units, as the shared limit is.
 */
function findAgentNameProblem(
  name: string,
  subject: AgentDraftSubject,
  agents: readonly ListedAgentIdentity[]
): AgentDraftProblem | undefined {
  const trimmedName = name.trim()
  if (trimmedName === "") return { kind: "name-missing" }
  if (trimmedName.length > MAXIMUM_AGENT_NAME_LENGTH) {
    return { kind: "name-too-long" }
  }
  const comparableName = calculateComparableAgentName(trimmedName)
  if (isStoredAgentNameKept(comparableName, subject)) return undefined

  const isNameTaken = agents.some(
    (agent) =>
      !isDraftSubject(agent, subject) &&
      calculateComparableAgentName(agent.name) === comparableName
  )
  return isNameTaken ? { kind: "name-taken", name: trimmedName } : undefined
}

/**
 * Finds the code problem of a draft.
 *
 * @param subject - Agent the draft is written for; only a new agent's code is
 * checked, because a stored agent's code never changes.
 * @param agents - Every listed agent.
 * @returns The code problem, or undefined when the code can be saved.
 */
function findAgentCodeProblem(
  subject: AgentDraftSubject,
  agents: readonly ListedAgentIdentity[]
): AgentDraftProblem | undefined {
  if (subject.kind === "stored" || subject.code === "") return undefined
  if (!agentCodeSchema.safeParse(subject.code).success) {
    return { kind: "code-malformed" }
  }

  const isCodeTaken = agents.some((agent) => agent.code === subject.code)
  return isCodeTaken ? { kind: "code-taken", code: subject.code } : undefined
}

/**
 * Finds the bio problem of a draft.
 *
 * @param bio - Bio as typed.
 * @returns The bio problem, or undefined when the bio can be saved. The
 * trimmed bio is measured in UTF-16 code units, as the shared limit is.
 */
function findAgentBioProblem(bio: string): AgentDraftProblem | undefined {
  const trimmedBio = bio.trim()
  if (trimmedBio === "") return { kind: "bio-missing" }

  return trimmedBio.length > MAXIMUM_AGENT_BIO_LENGTH
    ? { kind: "bio-too-long" }
    : undefined
}

/**
 * Finds the first reason a draft cannot be saved.
 *
 * @param draft - Text as typed.
 * @param subject - Agent the draft is written for.
 * @param agents - Every listed agent, against which names and codes are
 * checked.
 * @returns The first problem in field order, or undefined when the draft can
 * be saved.
 * @remarks Names and bios are checked against the shared limits after
 * trimming, as the backend checks them. The backend remains the authority on
 * codes; a code taken since the list was read is refused when saving.
 */
export function findAgentDraftProblem(
  draft: AgentDraft,
  subject: AgentDraftSubject,
  agents: readonly ListedAgentIdentity[]
): AgentDraftProblem | undefined {
  const problem =
    findAgentNameProblem(draft.name, subject, agents) ??
    findAgentCodeProblem(subject, agents) ??
    findAgentBioProblem(draft.bio)
  if (problem !== undefined) return problem

  return draft.systemPrompt.trim() === ""
    ? { kind: "system-prompt-missing" }
    : undefined
}

/**
 * Calculates the editor field a draft problem concerns.
 *
 * @param problem - Problem found in a draft.
 * @returns The field to mark invalid and focus.
 */
export function calculateAgentDraftProblemField(
  problem: AgentDraftProblem
): AgentDraftField {
  switch (problem.kind) {
    case "name-missing":
    case "name-too-long":
    case "name-taken":
      return "name"
    case "code-malformed":
    case "code-taken":
      return "code"
    case "bio-missing":
    case "bio-too-long":
      return "bio"
    case "system-prompt-missing":
      return "systemPrompt"
  }
}

/**
 * Calculates the code text kept from text typed into the code field.
 *
 * @param text - Text as typed or pasted.
 * @returns Lowercase ASCII letters and digits in hyphen-separated groups, at
 * most {@link MAXIMUM_AGENT_CODE_LENGTH} characters. Accents are removed, and
 * each run of other characters becomes one hyphen; a leading hyphen is
 * dropped, but a trailing one is kept so that typing can continue after it.
 */
export function calculateAgentCodeFromText(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAXIMUM_AGENT_CODE_LENGTH)
}

/**
 * Calculates the code offered for an agent from its name.
 *
 * @param name - Name as typed.
 * @returns The name's code form without a trailing hyphen; empty when the
 * name has no letter or digit with an ASCII form.
 */
export function calculateAgentCodeFromName(name: string): string {
  return calculateAgentCodeFromText(name).replace(/-$/, "")
}

/**
 * Calculates the start of a name that leaves room for a suffix.
 *
 * @param name - Trimmed, non-empty name.
 * @param suffixLength - UTF-16 length of the suffix that follows.
 * @returns The name cut to fit {@link MAXIMUM_AGENT_NAME_LENGTH} with the
 * suffix, without trailing whitespace and without splitting a surrogate pair.
 */
function calculateAgentNameBase(name: string, suffixLength: number): string {
  const cutName = name.slice(0, MAXIMUM_AGENT_NAME_LENGTH - suffixLength)
  const isPairSplit = /[\uD800-\uDBFF]$/.test(cutName)

  return (isPairSplit ? cutName.slice(0, -1) : cutName).trimEnd()
}

/**
 * Builds one candidate name for a copy of an agent.
 *
 * @param name - Trimmed, non-empty name of the agent being copied.
 * @param copyNumber - One-based number of the candidate: the first is
 * `<name> copy`, and each later one is `<name> copy <n>`.
 * @returns The candidate, at most {@link MAXIMUM_AGENT_NAME_LENGTH} long.
 */
function buildAgentCopyName(name: string, copyNumber: number): string {
  const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`

  return `${calculateAgentNameBase(name, suffix.length)}${suffix}`
}

/**
 * Calculates the name given to a copy of an agent.
 *
 * @param name - Name of the agent being copied.
 * @param agents - Every listed agent, whose names the copy must not repeat.
 * @returns `<name> copy`, or `<name> copy <n>` with the smallest n from 2 that
 * no listed agent uses, compared case-insensitively. The name is cut so the
 * result fits {@link MAXIMUM_AGENT_NAME_LENGTH}; a blank name is replaced by
 * `Agent`.
 */
export function calculateDuplicateAgentName(
  name: string,
  agents: readonly ListedAgentIdentity[]
): string {
  const takenNames = new Set(
    agents.map((agent) => calculateComparableAgentName(agent.name))
  )
  const trimmedName = name.trim()
  const copiedName = trimmedName === "" ? "Agent" : trimmedName
  let copyNumber = 1
  while (
    takenNames.has(
      calculateComparableAgentName(buildAgentCopyName(copiedName, copyNumber))
    )
  ) {
    copyNumber += 1
  }

  return buildAgentCopyName(copiedName, copyNumber)
}

/**
 * Builds the draft that starts editing a stored agent.
 *
 * @param agent - Stored agent.
 * @returns A frozen draft holding the stored text.
 */
export function buildStoredAgentDraft(agent: Agent): AgentDraft {
  return Object.freeze({
    name: agent.name,
    bio: agent.bio,
    systemPrompt: agent.systemPrompt
  })
}

/**
 * Reports whether a draft differs from the stored agent it edits.
 *
 * @param draft - Text as typed.
 * @param agent - Stored agent.
 * @returns Whether any field differs exactly, whitespace included.
 */
export function isAgentDraftChanged(draft: AgentDraft, agent: Agent): boolean {
  return (
    draft.name !== agent.name ||
    draft.bio !== agent.bio ||
    draft.systemPrompt !== agent.systemPrompt
  )
}

/**
 * Reports whether anything was typed for a new agent.
 *
 * @param draft - Text as typed.
 * @param code - Code as typed.
 * @returns Whether any field, the code included, holds text.
 */
export function isNewAgentDraftStarted(
  draft: AgentDraft,
  code: string
): boolean {
  const typedTexts = [draft.name, code, draft.bio, draft.systemPrompt]

  return typedTexts.some((text) => text !== "")
}
