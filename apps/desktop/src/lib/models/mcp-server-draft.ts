import {
  MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT,
  MAXIMUM_MCP_COMMAND_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  MAXIMUM_MCP_HEADER_COUNT,
  MAXIMUM_MCP_HEADER_VALUE_LENGTH,
  MAXIMUM_MCP_SERVER_NAME_LENGTH,
  MAXIMUM_MCP_SERVER_URL_LENGTH,
  mcpServerSettingsSchema,
  type McpServerSettings,
  type McpServerSettingsCandidate,
  type McpServerTransport
} from "@lys/share"

/**
 * One MCP server as the person types it in the editor: every field as text,
 * the lists one item per line.
 */
export type McpServerDraft = {
  /** Server name as typed. */
  readonly name: string
  /** How Lys talks to the server: a command it starts, or a URL. */
  readonly transport: McpServerTransport
  /** Command as typed; used for a command server. */
  readonly command: string
  /** Arguments, one per line; used for a command server. */
  readonly argumentLines: string
  /** Environment variables as `NAME=value`, one per line; command server. */
  readonly environmentLines: string
  /** URL as typed; used for a URL server. */
  readonly url: string
  /** Headers as `Name: value`, one per line; used for a URL server. */
  readonly headerLines: string
}

/** Field of the editor a problem concerns. */
export type McpServerDraftField =
  "name" | "command" | "arguments" | "environment" | "url" | "headers"

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

/** One non-empty line of a list field, with where it is. */
type DraftLine = {
  /** One-based number of the line in the field. */
  readonly lineNumber: number
  /** Text of the line. */
  readonly text: string
}

/** Items read from a list field, and the line each one came from. */
type DraftListRead<TItem> = {
  /** Items in line order. */
  readonly items: readonly TItem[]
  /** Line number of each item, by item index. */
  readonly lineNumbers: readonly number[]
  /** Problem of the first line that is not an item, if any. */
  readonly problem: string | undefined
}

/** One problem the shared server schema reports. */
type McpServerSchemaIssue = NonNullable<
  ReturnType<typeof mcpServerSettingsSchema.safeParse>["error"]
>["issues"][number]

/** Lines of every list field of a draft, by field. */
type DraftLineNumbers = Readonly<
  Partial<Record<McpServerDraftField, readonly number[]>>
>

/** Fields of the editor, in the order they are shown. */
export const MCP_SERVER_DRAFT_FIELDS: readonly McpServerDraftField[] =
  Object.freeze([
    "name",
    "command",
    "arguments",
    "environment",
    "url",
    "headers"
  ])

/** Draft of a new server: a command server with every field empty. */
export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = Object.freeze({
  name: "",
  transport: "stdio",
  command: "",
  argumentLines: "",
  environmentLines: "",
  url: "",
  headerLines: ""
})

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
  headers: `A server is sent at most ${MAXIMUM_MCP_HEADER_COUNT} headers.`
} satisfies Readonly<Record<McpServerDraftField, string>>)

/** Rule of a header value broken by its length. */
const HEADER_VALUE_LIMIT_PROBLEM = `A header value is up to ${MAXIMUM_MCP_HEADER_VALUE_LENGTH} characters.`

/** Problem of a server whose name another server already has. */
const DUPLICATE_NAME_PROBLEM = "Another MCP server already has this name."

/** Finds spaces and tabs at either end of a header value. */
const HEADER_VALUE_EDGE_PATTERN = /^[ \t]+|[ \t]+$/g

/**
 * Builds the draft of a saved server, for editing it.
 *
 * @param server - Saved server settings.
 * @returns A frozen draft whose fields read back as the same settings: one
 * argument per line, variables as `NAME=value`, headers as `Name: value`.
 * The fields of the other transport are empty.
 */
export function buildMcpServerDraft(server: McpServerSettings): McpServerDraft {
  if (server.transport === "http") {
    return Object.freeze({
      ...EMPTY_MCP_SERVER_DRAFT,
      name: server.name,
      transport: "http",
      url: server.url,
      headerLines: server.headers
        .map((header) => `${header.name}: ${header.value}`)
        .join("\n")
    })
  }
  return Object.freeze({
    ...EMPTY_MCP_SERVER_DRAFT,
    name: server.name,
    command: server.command,
    argumentLines: server.arguments.join("\n"),
    environmentLines: server.environment
      .map((variable) => `${variable.name}=${variable.value}`)
      .join("\n")
  })
}

/**
 * Lists the non-empty lines of a list field.
 *
 * @param text - Field text.
 * @returns Each line that is not empty, with its one-based number; a line of
 * spaces is kept.
 */
function listDraftLines(text: string): readonly DraftLine[] {
  return text
    .split("\n")
    .map((line, index) => ({ lineNumber: index + 1, text: line }))
    .filter((line) => line.text !== "")
}

/**
 * Reads the items of a list field, one per line, and the line of each.
 *
 * @typeParam TItem - Item a line holds.
 * @param text - Field text.
 * @param readLine - Reads one line's item, or undefined when the line is not
 * written as one.
 * @param formatProblem - Explains a line that is not an item.
 * @returns The items, their lines, and the problem of the first line that is
 * not an item.
 */
function readDraftList<TItem>(
  text: string,
  readLine: (line: string) => TItem | undefined,
  formatProblem: (lineNumber: number) => string
): DraftListRead<TItem> {
  const items: TItem[] = []
  const lineNumbers: number[] = []
  let problem: string | undefined
  for (const line of listDraftLines(text)) {
    const item = readLine(line.text)
    if (item !== undefined) {
      items.push(item)
      lineNumbers.push(line.lineNumber)
    } else problem ??= formatProblem(line.lineNumber)
  }
  return { items, lineNumbers, problem }
}

/**
 * Reads one `NAME=value` line.
 *
 * @param line - Line text.
 * @returns The variable, its name without spaces at either end and its value
 * as written, or undefined when the line has no `=`.
 */
function readEnvironmentLine(
  line: string
): { readonly name: string; readonly value: string } | undefined {
  const separator = line.indexOf("=")
  if (separator === -1) return undefined
  return {
    name: line.slice(0, separator).trim(),
    value: line.slice(separator + 1)
  }
}

/**
 * Reads one `Name: value` line.
 *
 * @param line - Line text.
 * @returns The header, its name without spaces at either end and its value
 * without spaces or tabs at either end, or undefined when the line has no
 * `:`.
 */
function readHeaderLine(
  line: string
): { readonly name: string; readonly value: string } | undefined {
  const separator = line.indexOf(":")
  if (separator === -1) return undefined
  const value = line.slice(separator + 1).replace(HEADER_VALUE_EDGE_PATTERN, "")
  return { name: line.slice(0, separator).trim(), value }
}

/** One draft read as candidate settings, before the shared schema. */
type DraftCandidateRead = {
  /** Candidate settings for the shared server schema. */
  readonly candidate: McpServerSettingsCandidate
  /** Line of each item of the list fields. */
  readonly lineNumbers: DraftLineNumbers
  /** Problems found before the schema: lines not written as items. */
  readonly problems: McpServerDraftProblems
}

/**
 * Reads a command server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `stdio`.
 * @returns The candidate, its lines, and the lines not written as items.
 */
function readStdioDraft(draft: McpServerDraft): DraftCandidateRead {
  const argumentLines = listDraftLines(draft.argumentLines)
  const environment = readDraftList(
    draft.environmentLines,
    readEnvironmentLine,
    (lineNumber) => `Line ${lineNumber}: write each variable as NAME=value.`
  )
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "stdio",
    command: draft.command.trim(),
    arguments: argumentLines.map((line) => line.text),
    environment: environment.items
  }
  return {
    candidate,
    lineNumbers: {
      arguments: argumentLines.map((line) => line.lineNumber),
      environment: environment.lineNumbers
    },
    problems:
      environment.problem === undefined
        ? {}
        : { environment: environment.problem }
  }
}

/**
 * Reads a URL server's draft as candidate settings.
 *
 * @param draft - Draft whose transport is `http`.
 * @returns The candidate, its lines, and the lines not written as items.
 */
function readHttpDraft(draft: McpServerDraft): DraftCandidateRead {
  const headers = readDraftList(
    draft.headerLines,
    readHeaderLine,
    (lineNumber) => `Line ${lineNumber}: write each header as Name: value.`
  )
  const candidate: McpServerSettingsCandidate = {
    name: draft.name.trim(),
    transport: "http",
    url: draft.url.trim(),
    headers: headers.items
  }
  return {
    candidate,
    lineNumbers: { headers: headers.lineNumbers },
    problems: headers.problem === undefined ? {} : { headers: headers.problem }
  }
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
  return MCP_SERVER_DRAFT_FIELDS.some((field) => field === key)
}

/**
 * Formats one schema problem as the sentence its field shows.
 *
 * @param issue - Problem the shared schema reported.
 * @param field - Field the problem concerns.
 * @param lineNumbers - Line of each item of the list fields.
 * @returns The schema's sentence, or the rule of a length or count the
 * schema reports without one; a problem of one item of a list starts with
 * the item's line. Of the items, only a header value has such a rule.
 */
function formatDraftIssue(
  issue: McpServerSchemaIssue,
  field: McpServerDraftField,
  lineNumbers: DraftLineNumbers
): string {
  const isLimit = issue.code === "too_big" || issue.code === "too_small"
  const itemIndex = issue.path[1]
  if (typeof itemIndex !== "number") {
    return isLimit ? FIELD_LIMIT_PROBLEMS[field] : issue.message
  }
  const message = isLimit ? HEADER_VALUE_LIMIT_PROBLEM : issue.message
  const lineNumber = lineNumbers[field]?.[itemIndex] ?? itemIndex + 1
  return `Line ${lineNumber}: ${message}`
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
    const field = issue.path[0]
    if (!isDraftField(field)) continue
    problems[field] ??= formatDraftIssue(issue, field, read.lineNumbers)
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
 * `invalid` with the first problem of each field. The name, command, and URL
 * are read without spaces at either end; empty lines of a list are skipped,
 * and every other line is one item.
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
