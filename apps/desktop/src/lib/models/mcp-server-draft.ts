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

/** Input of a row: its name or its value. */
export type McpDraftEntryPart = "name" | "value"

/** Row input that the problem of its list concerns. */
export type McpDraftProblemEntry = {
  /** Identity of the row. */
  readonly entryId: number
  /** Input of the row that breaks the rule. */
  readonly part: McpDraftEntryPart
}

/**
 * Row input that each list's problem concerns. A list whose problem is of
 * the whole list, such as too many rows, has none.
 */
export type McpDraftProblemEntries = Readonly<
  Partial<Record<McpDraftEntryList, McpDraftProblemEntry>>
>

/** Problems of a draft that breaks at least one rule. */
export type McpServerDraftProblemReport = {
  /** First problem of each field that has one. */
  readonly problems: McpServerDraftProblems
  /** Row input each list's problem concerns, for a problem of one row. */
  readonly problemEntries: McpDraftProblemEntries
}

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
      /** Row input each list's problem concerns, for a problem of one row. */
      readonly problemEntries: McpDraftProblemEntries
    }

/** One problem the shared server schema reports. */
type McpServerSchemaIssue = NonNullable<
  ReturnType<typeof mcpServerSettingsSchema.safeParse>["error"]
>["issues"][number]

/** List of the candidate settings whose items come from rows or the token. */
type CandidateList = "arguments" | "environment" | "headers"

/** Row an item of a candidate list comes from. */
type DraftEntrySource = {
  /** The item was typed in a row. */
  readonly kind: "entry"
  /** List holding the row. */
  readonly list: McpDraftEntryList
  /** One-based position of the row among all rows of its list. */
  readonly position: number
  /** Identity of the row. */
  readonly entryId: number
}

/** Where an item of a candidate list was typed. */
type DraftItemSource =
  | {
      /** The item is the header the token is sent in. */
      readonly kind: "token"
    }
  | {
      /** The item is an argument of the arguments line. */
      readonly kind: "argument"
      /** One-based position of the argument. */
      readonly position: number
    }
  | DraftEntrySource

/** Source of each item of the candidate's lists, by list and index. */
type DraftItemSources = Readonly<
  Partial<Record<CandidateList, readonly DraftItemSource[]>>
>

/** A row the person wrote something in, with where it is. */
type WrittenDraftEntry = McpDraftEntry & {
  /** One-based position of the row among all rows of its list. */
  readonly position: number
}

/** One problem placed in the field it concerns. */
type PlacedDraftProblem =
  | {
      /** The problem concerns a field's input, or a list as a whole. */
      readonly kind: "field"
      /** Field with the problem. */
      readonly field: McpServerDraftField
      /** The problem as one sentence. */
      readonly text: string
    }
  | {
      /** The problem concerns one input of a row. */
      readonly kind: "entry"
      /** List holding the row. */
      readonly field: McpDraftEntryList
      /** The problem as one sentence, after the row's position. */
      readonly text: string
      /** Row input the problem concerns. */
      readonly entry: McpDraftProblemEntry
    }

/** One draft read as candidate settings, before the shared schema. */
type DraftCandidateRead = {
  /** Candidate settings for the shared server schema. */
  readonly candidate: McpServerSettingsCandidate
  /** Source of each item of the candidate's lists, by list and index. */
  readonly itemSources: DraftItemSources
  /**
   * First row of the transport's list whose name repeats an earlier row's,
   * as the shared rule compares names, or undefined when none repeats.
   */
  readonly repeatedEntry: DraftEntrySource | undefined
  /** Problems found before the schema, in the order they are reported. */
  readonly problems: readonly PlacedDraftProblem[]
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

/** Rule of one argument broken by its length. */
const ARGUMENT_LIMIT_PROBLEM = `An argument is 1 to ${MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} characters.`

/** Rule of one row broken by its length, by list; a variable has none. */
const ENTRY_LIMIT_PROBLEMS: Readonly<
  Partial<Record<McpDraftEntryList, string>>
> = Object.freeze({
  headers: `A header value is up to ${MAXIMUM_MCP_HEADER_VALUE_LENGTH} characters.`
})

/** What a row is called before its position in a problem, by list. */
const ENTRY_NAMES: Readonly<Record<McpDraftEntryList, string>> = Object.freeze({
  environment: "Variable",
  headers: "Header"
})

/** Whether the shared rule compares a list's names ignoring case, by list. */
const ENTRY_NAMES_IGNORE_CASE: Readonly<Record<McpDraftEntryList, boolean>> =
  Object.freeze({
    environment: false,
    headers: true
  })

/** Inputs of a row, in the order they are shown. */
const MCP_DRAFT_ENTRY_PARTS: readonly McpDraftEntryPart[] = Object.freeze([
  "name",
  "value"
])

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

/** Source of the item the token is sent as. */
const TOKEN_ITEM_SOURCE: DraftItemSource = Object.freeze({ kind: "token" })

/** No problem placed. */
const NO_PLACED_PROBLEMS: readonly PlacedDraftProblem[] = Object.freeze([])

/** Problem of a name another saved server has. */
const TAKEN_NAME_PROBLEM: PlacedDraftProblem = Object.freeze({
  kind: "field",
  field: "name",
  text: DUPLICATE_NAME_PROBLEM
})

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
 * Builds a draft with a URL server's fields.
 *
 * @param draft - Draft to fill; its name and the command fields are kept.
 * @param url - Endpoint of the server.
 * @param headers - Headers in order. The first one carrying a bearer token
 * becomes the token; the others become rows, numbered from the draft's next
 * row identity.
 * @returns A new frozen draft whose transport is `http`, signing in with a
 * token when a header carries one.
 */
export function buildMcpHttpDraft(
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
 * Builds a draft with a command server's fields.
 *
 * @param draft - Draft to fill; its name and the URL fields are kept.
 * @param command - Program that starts the server.
 * @param commandArguments - Arguments in order.
 * @param variables - Environment variables in order, which become rows
 * numbered from the draft's next row identity.
 * @returns A new frozen draft whose transport is `stdio`, with the arguments
 * on one line, quoted where needed.
 */
export function buildMcpStdioDraft(
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
    return buildMcpHttpDraft(named, server.url, server.headers)
  }
  return buildMcpStdioDraft(
    named,
    server.command,
    server.arguments,
    server.environment
  )
}

/**
 * Builds a draft with one list's rows replaced.
 *
 * @param draft - Draft, left unchanged.
 * @param list - List whose rows are replaced.
 * @param entries - Frozen rows the list holds from now on.
 * @param nextEntryId - Identity the next added row takes.
 * @returns A new frozen draft; its other fields are the draft's.
 */
function buildDraftWithEntries(
  draft: McpServerDraft,
  list: McpDraftEntryList,
  entries: readonly McpDraftEntry[],
  nextEntryId: number
): McpServerDraft {
  switch (list) {
    case "environment":
      return Object.freeze({ ...draft, environment: entries, nextEntryId })
    case "headers":
      return Object.freeze({ ...draft, headers: entries, nextEntryId })
  }
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
  const nextDraft = buildDraftWithEntries(
    draft,
    list,
    entries,
    draft.nextEntryId + 1
  )
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
  return buildDraftWithEntries(
    draft,
    list,
    Object.freeze(entries),
    draft.nextEntryId
  )
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
  return buildDraftWithEntries(
    draft,
    list,
    Object.freeze(entries),
    draft.nextEntryId
  )
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
 * Builds a header value without the spaces and tabs at either end.
 *
 * @param text - Value as typed.
 * @returns The text without spaces or tabs at either end; other white space
 * stays, so the shared rule reports it.
 * @remarks Reads each character at most once, so a long run of spaces costs
 * linear time, which an end-anchored pattern does not guarantee.
 */
function buildTrimmedHeaderValue(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && HEADER_VALUE_EDGE_CHARACTERS.has(text.charAt(start)))
    start += 1
  while (end > start && HEADER_VALUE_EDGE_CHARACTERS.has(text.charAt(end - 1)))
    end -= 1
  return text.slice(start, end)
}

/**
 * Builds the source of a row an item comes from.
 *
 * @param list - List holding the row.
 * @param entry - Row the person wrote something in.
 * @returns The row's source.
 */
function buildEntrySource(
  list: McpDraftEntryList,
  entry: WrittenDraftEntry
): DraftEntrySource {
  return { kind: "entry", list, position: entry.position, entryId: entry.id }
}

/**
 * Builds the problem of one field's input, or of a list as a whole.
 *
 * @param field - Field with the problem.
 * @param text - The problem as one sentence.
 * @returns The placed problem.
 */
function buildFieldProblem(
  field: McpServerDraftField,
  text: string
): PlacedDraftProblem {
  return { kind: "field", field, text }
}

/**
 * Builds the problem of one row, after the row's position.
 *
 * @param source - Row with the problem.
 * @param part - Input of the row that breaks the rule, or undefined when the
 * rule concerns the row as a whole.
 * @param rule - The rule the row breaks.
 * @returns The problem, such as `Variable 2: <rule>`, concerning the input
 * when there is one, or the list otherwise.
 */
function buildEntryProblem(
  source: DraftEntrySource,
  part: McpDraftEntryPart | undefined,
  rule: string
): PlacedDraftProblem {
  const text = `${ENTRY_NAMES[source.list]} ${source.position}: ${rule}`
  if (part === undefined) return buildFieldProblem(source.list, text)
  const entry: McpDraftProblemEntry = { entryId: source.entryId, part }
  return { kind: "entry", field: source.list, text, entry }
}

/**
 * Finds the first row whose name repeats an earlier row's.
 *
 * @param list - List holding the rows.
 * @param rows - Rows the person wrote something in, in order.
 * @returns The source of that row, or undefined when no name repeats.
 * Names are compared without spaces at either end, and header names
 * ignoring case, as the shared rule compares them.
 */
function findRepeatedEntry(
  list: McpDraftEntryList,
  rows: readonly WrittenDraftEntry[]
): DraftEntrySource | undefined {
  const seenNames = new Set<string>()
  for (const row of rows) {
    const trimmedName = row.name.trim()
    const comparedName = ENTRY_NAMES_IGNORE_CASE[list]
      ? trimmedName.toLowerCase()
      : trimmedName
    if (seenNames.has(comparedName)) return buildEntrySource(list, row)
    seenNames.add(comparedName)
  }
  return undefined
}

/**
 * Reads a command server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `stdio`.
 * @returns The candidate, the source of each argument and variable, the
 * first repeated variable, and a quote left open in the arguments.
 */
function readStdioDraft(draft: McpServerDraft): DraftCandidateRead {
  const parsedArguments = parseMcpCommandArguments(draft.argumentText)
  const commandArguments =
    parsedArguments.status === "parsed" ? parsedArguments.arguments : []
  const variables = listWrittenEntries(draft.environment)
  const environment = variables.map(({ name, value }) => ({
    name: name.trim(),
    value
  }))
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "stdio",
    command: draft.command.trim(),
    arguments: [...commandArguments],
    environment
  }
  const argumentSources = commandArguments.map((_, index): DraftItemSource => ({
    kind: "argument",
    position: index + 1
  }))
  const variableSources = variables.map((variable) =>
    buildEntrySource("environment", variable)
  )
  const itemSources: DraftItemSources = {
    arguments: argumentSources,
    environment: variableSources
  }
  const problems =
    parsedArguments.status === "parsed"
      ? NO_PLACED_PROBLEMS
      : [
          buildFieldProblem(
            "arguments",
            `Close the quote at character ${parsedArguments.position}.`
          )
        ]
  const repeatedEntry = findRepeatedEntry("environment", variables)
  return { candidate, itemSources, repeatedEntry, problems }
}

/**
 * Finds what keeps a URL draft's sign-in from being sent.
 *
 * @param draft - Draft whose transport is `http`.
 * @param token - Token without spaces or tabs at either end.
 * @returns An empty token's problem, then the problem of the first header
 * row named Authorization beside the token, which concerns its name; none
 * without a token sign-in.
 */
function findSignInProblems(
  draft: McpServerDraft,
  token: string
): readonly PlacedDraftProblem[] {
  if (draft.signIn !== "token") return NO_PLACED_PROBLEMS
  const tokenProblems =
    token === "" ? [buildFieldProblem("token", EMPTY_TOKEN_PROBLEM)] : []
  const authorizationIndex = draft.headers.findIndex(
    (header) => header.name.trim().toLowerCase() === "authorization"
  )
  const authorizationHeader = draft.headers[authorizationIndex]
  if (authorizationHeader === undefined) return tokenProblems
  const authorizationRow: WrittenDraftEntry = {
    ...authorizationHeader,
    position: authorizationIndex + 1
  }
  const authorizationSource = buildEntrySource("headers", authorizationRow)
  const headerProblem = buildEntryProblem(
    authorizationSource,
    "name",
    AUTHORIZATION_HEADER_PROBLEM
  )
  return [...tokenProblems, headerProblem]
}

/**
 * Reads a URL server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `http`.
 * @returns The candidate, whose first header is the token's while signing
 * in with one, the source of each header, the first repeated header row,
 * and the sign-in's problems.
 */
function readHttpDraft(draft: McpServerDraft): DraftCandidateRead {
  const token = buildTrimmedHeaderValue(draft.token)
  const isTokenSent = draft.signIn === "token" && token !== ""
  const tokenHeader: McpHeader = {
    name: TOKEN_HEADER_NAME,
    value: `${TOKEN_VALUE_PREFIX}${token}`
  }
  const tokenHeaders = isTokenSent ? [tokenHeader] : []
  const rows = listWrittenEntries(draft.headers)
  const rowHeaders = rows.map(({ name, value }) => ({
    name: name.trim(),
    value: buildTrimmedHeaderValue(value)
  }))
  const headers = [...tokenHeaders, ...rowHeaders]
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "http",
    url: draft.url.trim(),
    headers
  }
  const tokenSources = isTokenSent ? [TOKEN_ITEM_SOURCE] : []
  const rowSources = rows.map((row) => buildEntrySource("headers", row))
  const headerSources = [...tokenSources, ...rowSources]
  const itemSources: DraftItemSources = { headers: headerSources }
  const repeatedEntry = findRepeatedEntry("headers", rows)
  const problems = findSignInProblems(draft, token)
  return { candidate, itemSources, repeatedEntry, problems }
}

/**
 * Reads a draft as candidate settings of its transport.
 *
 * @param draft - Draft as typed.
 * @returns The candidate read from the fields of the draft's transport.
 */
function readDraftCandidate(draft: McpServerDraft): DraftCandidateRead {
  switch (draft.transport) {
    case "stdio":
      return readStdioDraft(draft)
    case "http":
      return readHttpDraft(draft)
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
 * Answers whether a schema problem is about a length or a number of items.
 *
 * @param issue - Problem the shared schema reported.
 * @returns True when a value or a list is too long or too short.
 */
function isLimitIssue(issue: McpServerSchemaIssue): boolean {
  return issue.code === "too_big" || issue.code === "too_small"
}

/**
 * Finds the input of a row a schema path names.
 *
 * @param key - Key of the path after the row's index.
 * @returns `name` or `value`, or undefined for a path that names neither.
 */
function findEntryPart(
  key: PropertyKey | undefined
): McpDraftEntryPart | undefined {
  return MCP_DRAFT_ENTRY_PARTS.find((part) => part === key)
}

/**
 * Builds the placed problem of one item of a list, formatted.
 *
 * @param issue - Problem the shared schema reported for the item.
 * @param source - Where the item was typed.
 * @param partKey - Key of the path after the item's index.
 * @returns The token's problem, or the rule the item breaks after its
 * position, such as `Variable 2: `, concerning the row input it names.
 */
function buildPlacedItemIssue(
  issue: McpServerSchemaIssue,
  source: DraftItemSource,
  partKey: PropertyKey | undefined
): PlacedDraftProblem {
  const isLimit = isLimitIssue(issue)
  switch (source.kind) {
    case "token":
      return buildFieldProblem(
        "token",
        isLimit ? FIELD_LIMIT_PROBLEMS.token : TOKEN_FORMAT_PROBLEM
      )
    case "argument": {
      const rule = isLimit ? ARGUMENT_LIMIT_PROBLEM : issue.message
      return buildFieldProblem(
        "arguments",
        `Argument ${source.position}: ${rule}`
      )
    }
    case "entry": {
      const limitProblem = isLimit
        ? ENTRY_LIMIT_PROBLEMS[source.list]
        : undefined
      const rule = limitProblem ?? issue.message
      return buildEntryProblem(source, findEntryPart(partKey), rule)
    }
  }
}

/**
 * Finds the field of one schema problem and formats the problem.
 *
 * @param issue - Problem the shared schema reported.
 * @param read - Draft read, with the source of each item and the first
 * repeated row.
 * @returns The placed problem, or undefined for a path outside the editor's
 * fields. A list's repeated name concerns the first row that repeats one.
 */
function findPlacedDraftIssue(
  issue: McpServerSchemaIssue,
  read: DraftCandidateRead
): PlacedDraftProblem | undefined {
  const [key, itemIndex, partKey] = issue.path
  const source =
    isCandidateList(key) && typeof itemIndex === "number"
      ? read.itemSources[key]?.[itemIndex]
      : undefined
  if (source !== undefined) return buildPlacedItemIssue(issue, source, partKey)
  if (!isDraftField(key)) return undefined
  const repeatedEntry = read.repeatedEntry
  if (issue.code === "custom" && repeatedEntry?.list === key) {
    return buildEntryProblem(repeatedEntry, "name", issue.message)
  }
  const isLimit = isLimitIssue(issue)
  return buildFieldProblem(
    key,
    isLimit ? FIELD_LIMIT_PROBLEMS[key] : issue.message
  )
}

/**
 * Lists the schema's problems placed in their fields.
 *
 * @param issues - Problems the shared schema reported, in its order.
 * @param read - Draft read, with the source of each item.
 * @returns The placed problems in the schema's order, without those outside
 * the editor's fields.
 */
function listSchemaProblems(
  issues: readonly McpServerSchemaIssue[],
  read: DraftCandidateRead
): readonly PlacedDraftProblem[] {
  return issues
    .map((issue) => findPlacedDraftIssue(issue, read))
    .filter((placed) => placed !== undefined)
}

/**
 * Builds the report of a draft's problems.
 *
 * @param placedProblems - Problems in the order they are reported.
 * @returns A frozen report with the first problem of each field and, for a
 * list whose first problem concerns one row's input, that input.
 */
function buildDraftProblemReport(
  placedProblems: readonly PlacedDraftProblem[]
): McpServerDraftProblemReport {
  const problems: Partial<Record<McpServerDraftField, string>> = {}
  const problemEntries: Partial<
    Record<McpDraftEntryList, McpDraftProblemEntry>
  > = {}
  for (const placed of placedProblems) {
    if (problems[placed.field] !== undefined) continue
    problems[placed.field] = placed.text
    if (placed.kind === "entry") problemEntries[placed.field] = placed.entry
  }
  const fieldProblems: McpServerDraftProblems = Object.freeze(problems)
  const entryProblems: McpDraftProblemEntries = Object.freeze(problemEntries)
  return Object.freeze({
    problems: fieldProblems,
    problemEntries: entryProblems
  })
}

/**
 * Reads a draft as server settings, checking every rule a saved server
 * follows.
 *
 * @param draft - Draft as typed.
 * @param otherServerNames - Names of the other saved servers; the edited
 * server's own saved name is not among them.
 * @returns `valid` with the settings the shared server schema returns, or
 * `invalid` with the first problem of each field and the row input each
 * list's problem concerns. The name, command, URL, and variable and header
 * names are read without spaces at either end, and header values and the
 * token without spaces or tabs at either end. Rows with neither a name nor
 * a value are skipped. A token is sent as the first header,
 * `Authorization: Bearer <token>`. A problem of one row starts with the
 * row's position and concerns its name or value; a repeated name concerns
 * the first row that repeats it.
 */
export function parseMcpServerDraft(
  draft: McpServerDraft,
  otherServerNames: ReadonlySet<string>
): McpServerDraftParse {
  const read = readDraftCandidate(draft)
  const parsed = mcpServerSettingsSchema.safeParse(read.candidate)
  const schemaProblems = parsed.success
    ? NO_PLACED_PROBLEMS
    : listSchemaProblems(parsed.error.issues, read)
  const nameProblems = otherServerNames.has(read.candidate.name)
    ? [TAKEN_NAME_PROBLEM]
    : NO_PLACED_PROBLEMS
  const placedProblems = [...read.problems, ...schemaProblems, ...nameProblems]
  if (parsed.success && placedProblems.length === 0) {
    return Object.freeze({ status: "valid", server: parsed.data })
  }
  const report = buildDraftProblemReport(placedProblems)
  return Object.freeze({
    status: "invalid",
    problems: report.problems,
    problemEntries: report.problemEntries
  })
}
