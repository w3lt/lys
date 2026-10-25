import {
  MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT,
  MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH,
  MAXIMUM_MCP_COMMAND_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  MAXIMUM_MCP_HEADER_COUNT,
  MAXIMUM_MCP_HEADER_VALUE_LENGTH,
  MAXIMUM_MCP_SERVER_NAME_LENGTH,
  MAXIMUM_MCP_SERVER_URL_LENGTH,
  mcpServerSettingsSchema,
  type McpHeader,
  type McpServerSettings,
  type McpServerSettingsCandidate,
  type McpServerTransport
} from "@lys/share"

import {
  formatMcpCommandArguments,
  parseMcpCommandArguments
} from "./mcp-command-arguments"

/** One row of a list of names and values in the editor. */
export type McpDraftEntry = {
  /** Identity of the row in its draft; no other row of the draft takes it. */
  readonly id: number
  /** Name as typed. */
  readonly name: string
  /** Value as typed, which may be a secret. */
  readonly value: string
}

/** List of rows of a draft: a command server's variables, or a URL server's headers. */
export type McpDraftEntryList = "environment" | "headers"

/** How Lys signs in to a URL server: not at all, or with a bearer token. */
export type McpSignIn = "none" | "token"

/** Ways to sign in, in the order the editor offers them. */
export const MCP_SIGN_INS: readonly McpSignIn[] = Object.freeze([
  "none",
  "token"
])

/**
 * One MCP server as the person types it in the editor.
 *
 * @remarks The fields of both transports are kept, so switching back shows
 * what was typed. A token is saved as the `Authorization: Bearer <token>`
 * header, and only while `signIn` is `token`.
 */
export type McpServerDraft = {
  /** Server name as typed. */
  readonly name: string
  /** How Lys talks to the server: a command it starts, or a URL. */
  readonly transport: McpServerTransport
  /** Command as typed; used for a command server. */
  readonly command: string
  /** Arguments on one line, quoted where needed; used for a command server. */
  readonly argumentText: string
  /** Environment variables, one row each; used for a command server. */
  readonly environment: readonly McpDraftEntry[]
  /** URL as typed; used for a URL server. */
  readonly url: string
  /** How Lys signs in to a URL server. */
  readonly signIn: McpSignIn
  /** Bearer token as typed; sent only while signing in with a token. */
  readonly token: string
  /** Headers other than the token's, one row each; used for a URL server. */
  readonly headers: readonly McpDraftEntry[]
  /** Identity the next added row takes. */
  readonly nextEntryId: number
}

/** A draft with one row added, and the row's identity. */
export type McpDraftEntryAddition = {
  /** Draft holding the new, empty row at the end of its list. */
  readonly draft: McpServerDraft
  /** Identity of the new row. */
  readonly entryId: number
}

/** Field of the editor a problem concerns. */
export type McpServerDraftField =
  "name" | "command" | "arguments" | "environment" | "url" | "token" | "headers"

/** Problem of each field that has one, as one sentence. */
export type McpServerDraftProblems = Readonly<
  Partial<Record<McpServerDraftField, string>>
>

/** Outcome of reading a draft as server settings. */
export type McpServerDraftParse =
  | {
      /** The draft is a server Lys can save. */
      readonly status: "valid"
      /** Settings validated by the shared server schema. */
      readonly server: McpServerSettings
    }
  | {
      /** The draft breaks at least one rule. */
      readonly status: "invalid"
      /** First problem of each field that has one. */
      readonly problems: McpServerDraftProblems
    }

/** One problem the shared server schema reports. */
type McpServerSchemaIssue = NonNullable<
  ReturnType<typeof mcpServerSettingsSchema.safeParse>["error"]
>["issues"][number]

/** List of the candidate settings whose items come from rows or the token. */
type CandidateList = "arguments" | "environment" | "headers"

/** Field and row an item of a candidate list comes from. */
type DraftItemSource = {
  /** Field the item was typed in. */
  readonly field: McpServerDraftField
  /** One-based position of its row or argument, or 0 for the token. */
  readonly position: number
}

/** A row the person wrote something in, with where it is. */
type WrittenDraftEntry = McpDraftEntry & Pick<DraftItemSource, "position">

/** One draft read as candidate settings, before the shared schema. */
type DraftCandidateRead = {
  /** Candidate settings for the shared server schema. */
  readonly candidate: McpServerSettingsCandidate
  /** Source of each item of the candidate's lists, by list and index. */
  readonly itemSources: Readonly<
    Partial<Record<CandidateList, readonly DraftItemSource[]>>
  >
  /** Problems found before the schema. */
  readonly problems: McpServerDraftProblems
}

/** Fields of the editor, in the order they are shown. */
export const MCP_SERVER_DRAFT_FIELDS: readonly McpServerDraftField[] =
  Object.freeze([
    "name",
    "command",
    "arguments",
    "environment",
    "url",
    "token",
    "headers"
  ])

/** Fields of a draft compared by value to tell whether it changed. */
const DRAFT_TEXT_FIELDS = Object.freeze([
  "name",
  "transport",
  "command",
  "argumentText",
  "url",
  "signIn",
  "token"
] as const)

/** Header a token is sent in. */
const TOKEN_HEADER_NAME = "Authorization"

/** Text before the token in its header's value. */
const TOKEN_VALUE_PREFIX = "Bearer "

/** Finds a bearer header value, ignoring case, and captures the token. */
const BEARER_VALUE_PATTERN = /^bearer[ \t]+(\S(?:.*\S)?)$/iu

/**
 * Rule of each field broken by its length or its number of items, which the
 * shared schema reports without a sentence of its own.
 */
const FIELD_LIMIT_PROBLEMS = Object.freeze({
  name: `An MCP server name is up to ${MAXIMUM_MCP_SERVER_NAME_LENGTH} characters.`,
  command: `Enter the command that starts the server, up to ${MAXIMUM_MCP_COMMAND_LENGTH} characters.`,
  arguments: `A server takes at most ${MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT} arguments.`,
  environment: `A server sets at most ${MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT} environment variables.`,
  url: `A URL is up to ${MAXIMUM_MCP_SERVER_URL_LENGTH} characters.`,
  token: `A token is up to ${MAXIMUM_MCP_HEADER_VALUE_LENGTH - TOKEN_VALUE_PREFIX.length} characters.`,
  headers: `A server is sent at most ${MAXIMUM_MCP_HEADER_COUNT} headers, the token's included.`
} satisfies Readonly<Record<McpServerDraftField, string>>)

/** Rule of one item broken by its length, by the field it was typed in. */
const ITEM_LIMIT_PROBLEMS: Readonly<
  Partial<Record<McpServerDraftField, string>>
> = Object.freeze({
  arguments: `An argument is 1 to ${MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} characters.`,
  token: FIELD_LIMIT_PROBLEMS.token,
  headers: `A header value is up to ${MAXIMUM_MCP_HEADER_VALUE_LENGTH} characters.`
})

/** What a row's position is called in a problem, by field. */
const ITEM_NAMES: Readonly<Partial<Record<McpServerDraftField, string>>> =
  Object.freeze({
    arguments: "Argument",
    environment: "Variable",
    headers: "Header"
  })

/** Problem of a token that breaks the header value rule. */
const TOKEN_FORMAT_PROBLEM =
  "A token is visible ASCII characters and spaces, without line breaks."

/** Problem of an empty token while signing in with one. */
const EMPTY_TOKEN_PROBLEM = "Enter the token, or set sign-in to None."

/** Problem of an Authorization header beside a token. */
const AUTHORIZATION_HEADER_PROBLEM =
  "The token is sent as the Authorization header. Remove this header, or set sign-in to None."

/** Problem of a server whose name another server already has. */
const DUPLICATE_NAME_PROBLEM = "Another MCP server already has this name."

/** Characters removed from either end of a header value or a token. */
const HEADER_VALUE_EDGE_CHARACTERS: ReadonlySet<string> = new Set([" ", "\t"])

/**
 * Builds the draft of a new server.
 *
 * @param transport - How Lys talks to the server.
 * @returns A frozen draft of that transport with every field empty, no row,
 * and no sign-in.
 */
export function buildEmptyMcpServerDraft(
  transport: McpServerTransport
): McpServerDraft {
  return Object.freeze({
    name: "",
    transport,
    command: "",
    argumentText: "",
    environment: Object.freeze([]),
    url: "",
    signIn: "none",
    token: "",
    headers: Object.freeze([]),
    nextEntryId: 1
  })
}

/**
 * Reads the token of a header that carries one.
 *
 * @param header - Header name and value.
 * @returns The token of an `Authorization` header whose value is `Bearer`
 * and the token, ignoring case and the spaces between; otherwise undefined.
 */
export function readBearerToken(header: McpHeader): string | undefined {
  if (header.name.toLowerCase() !== "authorization") return undefined
  return BEARER_VALUE_PATTERN.exec(header.value)?.[1]
}

/**
 * Builds the rows of a list of names and values.
 *
 * @param pairs - Names and values in order.
 * @param firstEntryId - Identity of the first row.
 * @returns A frozen list of frozen rows numbered from `firstEntryId`.
 */
function buildMcpDraftEntries(
  pairs: readonly Pick<McpDraftEntry, "name" | "value">[],
  firstEntryId: number
): readonly McpDraftEntry[] {
  return Object.freeze(
    pairs.map((pair, index) =>
      Object.freeze({
        id: firstEntryId + index,
        name: pair.name,
        value: pair.value
      })
    )
  )
}

/**
 * Fills a draft with a URL server's fields.
 *
 * @param draft - Draft to fill; its name and the command fields are kept.
 * @param url - Endpoint of the server.
 * @param headers - Headers in order. The first one carrying a bearer token
 * becomes the token; the others become rows, numbered from the draft's next
 * row identity.
 * @returns A new frozen draft whose transport is `http`, signing in with a
 * token when a header carries one.
 */
export function fillMcpHttpDraft(
  draft: McpServerDraft,
  url: string,
  headers: readonly McpHeader[]
): McpServerDraft {
  const tokens = headers.map(readBearerToken)
  const tokenIndex = tokens.findIndex((token) => token !== undefined)
  const token = tokens[tokenIndex]
  const otherHeaders = headers.filter((_, index) => index !== tokenIndex)
  return Object.freeze({
    ...draft,
    transport: "http",
    url,
    signIn: token === undefined ? "none" : "token",
    token: token ?? "",
    headers: buildMcpDraftEntries(otherHeaders, draft.nextEntryId),
    nextEntryId: draft.nextEntryId + otherHeaders.length
  })
}

/**
 * Fills a draft with a command server's fields.
 *
 * @param draft - Draft to fill; its name and the URL fields are kept.
 * @param command - Program that starts the server.
 * @param commandArguments - Arguments in order.
 * @param variables - Environment variables in order, which become rows
 * numbered from the draft's next row identity.
 * @returns A new frozen draft whose transport is `stdio`, with the arguments
 * on one line, quoted where needed.
 */
export function fillMcpStdioDraft(
  draft: McpServerDraft,
  command: string,
  commandArguments: readonly string[],
  variables: readonly Pick<McpDraftEntry, "name" | "value">[]
): McpServerDraft {
  return Object.freeze({
    ...draft,
    transport: "stdio",
    command,
    argumentText: formatMcpCommandArguments(commandArguments),
    environment: buildMcpDraftEntries(variables, draft.nextEntryId),
    nextEntryId: draft.nextEntryId + variables.length
  })
}

/**
 * Builds the draft of a saved server, for editing it.
 *
 * @param server - Saved server settings.
 * @returns A frozen draft that reads back as the same settings, except that
 * a bearer token is saved again as `Authorization: Bearer <token>`, the
 * first header. The fields of the other transport are empty.
 */
export function buildMcpServerDraft(server: McpServerSettings): McpServerDraft {
  const draft = buildEmptyMcpServerDraft(server.transport)
  const named = Object.freeze({ ...draft, name: server.name })
  if (server.transport === "http") {
    return fillMcpHttpDraft(named, server.url, server.headers)
  }
  return fillMcpStdioDraft(
    named,
    server.command,
    server.arguments,
    server.environment
  )
}

/**
 * Adds an empty row at the end of one list of a draft.
 *
 * @param draft - Draft, left unchanged.
 * @param list - List that takes the row.
 * @returns The new frozen draft and the row's identity.
 */
export function addMcpDraftEntry(
  draft: McpServerDraft,
  list: McpDraftEntryList
): McpDraftEntryAddition {
  const entry: McpDraftEntry = Object.freeze({
    id: draft.nextEntryId,
    name: "",
    value: ""
  })
  const entries = Object.freeze([...draft[list], entry])
  const nextDraft = Object.freeze({
    ...draft,
    [list]: entries,
    nextEntryId: draft.nextEntryId + 1
  })
  return Object.freeze({ draft: nextDraft, entryId: entry.id })
}

/**
 * Replaces one row of a draft.
 *
 * @param draft - Draft, left unchanged.
 * @param list - List that holds the row.
 * @param entry - Row with the identity of the row it replaces.
 * @returns A new frozen draft with the row replaced in place; unchanged
 * rows keep their values.
 */
export function updateMcpDraftEntry(
  draft: McpServerDraft,
  list: McpDraftEntryList,
  entry: McpDraftEntry
): McpServerDraft {
  const entries = draft[list].map((current) =>
    current.id === entry.id ? Object.freeze({ ...entry }) : current
  )
  return Object.freeze({ ...draft, [list]: Object.freeze(entries) })
}

/**
 * Removes one row of a draft.
 *
 * @param draft - Draft, left unchanged.
 * @param list - List that holds the row.
 * @param entryId - Identity of the row.
 * @returns A new frozen draft without the row; its identity is not reused.
 */
export function removeMcpDraftEntry(
  draft: McpServerDraft,
  list: McpDraftEntryList,
  entryId: number
): McpServerDraft {
  const entries = draft[list].filter((entry) => entry.id !== entryId)
  return Object.freeze({ ...draft, [list]: Object.freeze(entries) })
}

/**
 * Answers whether two lists of rows hold the same names and values.
 *
 * @param first - One list.
 * @param second - The other list.
 * @returns True when both have the same rows in the same order, compared by
 * name and value only.
 */
function hasSameEntries(
  first: readonly McpDraftEntry[],
  second: readonly McpDraftEntry[]
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (entry, index) =>
        entry.name === second[index]?.name &&
        entry.value === second[index]?.value
    )
  )
}

/**
 * Answers whether the person changed a draft.
 *
 * @param initial - Draft the editor opened with.
 * @param draft - Draft as it is now.
 * @returns True when a field or a row's name or value differs; row
 * identities are not compared.
 */
export function isMcpServerDraftChanged(
  initial: McpServerDraft,
  draft: McpServerDraft
): boolean {
  const hasSameText = DRAFT_TEXT_FIELDS.every(
    (field) => initial[field] === draft[field]
  )
  const hasSameRows =
    hasSameEntries(initial.environment, draft.environment) &&
    hasSameEntries(initial.headers, draft.headers)
  return !(hasSameText && hasSameRows)
}

/**
 * Lists the rows the person wrote something in.
 *
 * @param entries - Rows in order.
 * @returns Each row whose name or value is not empty, with its one-based
 * position among all rows; a row of spaces is kept.
 */
function listWrittenEntries(
  entries: readonly McpDraftEntry[]
): readonly WrittenDraftEntry[] {
  return entries
    .map((entry, index) => ({ ...entry, position: index + 1 }))
    .filter((entry) => entry.name !== "" || entry.value !== "")
}

/**
 * Removes the spaces and tabs at either end of a header value.
 *
 * @param text - Value as typed.
 * @returns The text without spaces or tabs at either end; other white space
 * stays, so the shared rule reports it.
 * @remarks Reads each character at most once, so a long run of spaces costs
 * linear time, which an end-anchored pattern does not guarantee.
 */
function trimHeaderValueEdges(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && HEADER_VALUE_EDGE_CHARACTERS.has(text.charAt(start)))
    start += 1
  while (end > start && HEADER_VALUE_EDGE_CHARACTERS.has(text.charAt(end - 1)))
    end -= 1
  return text.slice(start, end)
}

/**
 * Reads a command server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `stdio`.
 * @returns The candidate, the source of each argument and variable, and a
 * quote left open in the arguments.
 */
function readStdioDraft(draft: McpServerDraft): DraftCandidateRead {
  const parsedArguments = parseMcpCommandArguments(draft.argumentText)
  const commandArguments =
    parsedArguments.status === "parsed" ? parsedArguments.arguments : []
  const variables = listWrittenEntries(draft.environment)
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "stdio",
    command: draft.command.trim(),
    arguments: [...commandArguments],
    environment: variables.map(({ name, value }) => ({
      name: name.trim(),
      value
    }))
  }
  const problems: McpServerDraftProblems =
    parsedArguments.status === "parsed"
      ? {}
      : {
          arguments: `Close the quote at character ${parsedArguments.position}.`
        }
  return {
    candidate,
    itemSources: {
      arguments: commandArguments.map((_, index) => ({
        field: "arguments",
        position: index + 1
      })),
      environment: variables.map(({ position }) => ({
        field: "environment",
        position
      }))
    },
    problems
  }
}

/**
 * Finds what keeps a URL draft's sign-in from being sent.
 *
 * @param draft - Draft whose transport is `http`.
 * @param token - Token without spaces or tabs at either end.
 * @returns An empty token's problem, or an Authorization header beside the
 * token; none without a token sign-in.
 */
function findSignInProblems(
  draft: McpServerDraft,
  token: string
): McpServerDraftProblems {
  if (draft.signIn !== "token") return {}
  const hasAuthorizationHeader = draft.headers.some(
    (header) => header.name.trim().toLowerCase() === "authorization"
  )
  return {
    ...(token === "" ? { token: EMPTY_TOKEN_PROBLEM } : {}),
    ...(hasAuthorizationHeader ? { headers: AUTHORIZATION_HEADER_PROBLEM } : {})
  }
}

/**
 * Reads a URL server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `http`.
 * @returns The candidate, whose first header is the token's while signing
 * in with one, the source of each header, and the sign-in's problems.
 */
function readHttpDraft(draft: McpServerDraft): DraftCandidateRead {
  const token = trimHeaderValueEdges(draft.token)
  const isTokenSent = draft.signIn === "token" && token !== ""
  const tokenHeaders: McpHeader[] = isTokenSent
    ? [{ name: TOKEN_HEADER_NAME, value: `${TOKEN_VALUE_PREFIX}${token}` }]
    : []
  const rows = listWrittenEntries(draft.headers)
  const rowHeaders = rows.map(({ name, value }) => ({
    name: name.trim(),
    value: trimHeaderValueEdges(value)
  }))
  const tokenSources: DraftItemSource[] = isTokenSent
    ? [{ field: "token", position: 0 }]
    : []
  const rowSources = rows.map(({ position }): DraftItemSource => ({
    field: "headers",
    position
  }))
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "http",
    url: draft.url.trim(),
    headers: [...tokenHeaders, ...rowHeaders]
  }
  return {
    candidate,
    itemSources: { headers: [...tokenSources, ...rowSources] },
    problems: findSignInProblems(draft, token)
  }
}

/**
 * Answers whether a schema path names a list whose items come from rows.
 *
 * @param key - First key of the path.
 * @returns True for `arguments`, `environment`, and `headers`.
 */
function isCandidateList(key: PropertyKey | undefined): key is CandidateList {
  return key === "arguments" || key === "environment" || key === "headers"
}

/**
 * Answers whether a schema path names an editor field.
 *
 * @param key - First key of the path.
 * @returns True for a field of the editor.
 */
function isDraftField(
  key: PropertyKey | undefined
): key is McpServerDraftField {
  const draftFieldKeys: readonly (PropertyKey | undefined)[] =
    MCP_SERVER_DRAFT_FIELDS
  return draftFieldKeys.includes(key)
}

/**
 * Formats the problem of one item of a list.
 *
 * @param issue - Problem the shared schema reported for the item.
 * @param source - Field and position of the item.
 * @returns The rule the item breaks, after its position, such as
 * `Variable 2: `; a token's problem names the token instead.
 */
function formatItemIssue(
  issue: McpServerSchemaIssue,
  source: DraftItemSource
): string {
  const isLimit = issue.code === "too_big" || issue.code === "too_small"
  const limitProblem = isLimit ? ITEM_LIMIT_PROBLEMS[source.field] : undefined
  if (source.field === "token") return limitProblem ?? TOKEN_FORMAT_PROBLEM
  const itemName = ITEM_NAMES[source.field] ?? "Item"
  return `${itemName} ${source.position}: ${limitProblem ?? issue.message}`
}

/**
 * Places one schema problem in its field and formats it.
 *
 * @param issue - Problem the shared schema reported.
 * @param read - Draft read, with the source of each item.
 * @returns The field and its sentence, or undefined for a path outside the
 * editor's fields.
 */
function placeDraftIssue(
  issue: McpServerSchemaIssue,
  read: DraftCandidateRead
): readonly [McpServerDraftField, string] | undefined {
  const [key, itemIndex] = issue.path
  const source =
    isCandidateList(key) && typeof itemIndex === "number"
      ? read.itemSources[key]?.[itemIndex]
      : undefined
  if (source !== undefined)
    return [source.field, formatItemIssue(issue, source)]
  if (!isDraftField(key)) return undefined
  const isLimit = issue.code === "too_big" || issue.code === "too_small"
  return [key, isLimit ? FIELD_LIMIT_PROBLEMS[key] : issue.message]
}

/**
 * Collects the first problem of each field from the schema's problems.
 *
 * @param issues - Problems the shared schema reported, in its order.
 * @param read - Draft read, whose own problems come first.
 * @returns The first problem of each field.
 */
function collectDraftProblems(
  issues: readonly McpServerSchemaIssue[],
  read: DraftCandidateRead
): Partial<Record<McpServerDraftField, string>> {
  const problems: Partial<Record<McpServerDraftField, string>> = {
    ...read.problems
  }
  for (const issue of issues) {
    const placed = placeDraftIssue(issue, read)
    if (placed !== undefined) problems[placed[0]] ??= placed[1]
  }
  return problems
}

/**
 * Reads a draft as server settings, checking every rule a saved server
 * follows.
 *
 * @param draft - Draft as typed.
 * @param otherServerNames - Names of the other saved servers; the edited
 * server's own saved name is not among them.
 * @returns `valid` with the settings the shared server schema returns, or
 * `invalid` with the first problem of each field. The name, command, URL,
 * and variable and header names are read without spaces at either end, and
 * header values and the token without spaces or tabs at either end. Rows
 * with neither a name nor a value are skipped. A token is sent as the first
 * header, `Authorization: Bearer <token>`.
 */
export function parseMcpServerDraft(
  draft: McpServerDraft,
  otherServerNames: ReadonlySet<string>
): McpServerDraftParse {
  const read =
    draft.transport === "http" ? readHttpDraft(draft) : readStdioDraft(draft)
  const parsed = mcpServerSettingsSchema.safeParse(read.candidate)
  const problems = parsed.success
    ? { ...read.problems }
    : collectDraftProblems(parsed.error.issues, read)
  if (otherServerNames.has(read.candidate.name)) {
    problems.name ??= DUPLICATE_NAME_PROBLEM
  }
  if (parsed.success && Object.keys(problems).length === 0) {
    return Object.freeze({ status: "valid", server: parsed.data })
  }
  return Object.freeze({ status: "invalid", problems: Object.freeze(problems) })
}
