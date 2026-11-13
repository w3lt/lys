import { CREDENTIAL_FILE_LIST, type ChatToolCall } from "@lys/protocol"
import type { JsonValue } from "@lys/share"
import { isIP } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ApprovedFoldersRead } from "../../infrastructure/settings/approvedFoldersFile"
import { isLocalUrlHost } from "../tool/builtIn/web/webAddresses"

/** Arguments of one call, after `AgentTool` checked their types. */
type ToolCallArguments = ChatToolCall["arguments"]

/**
 * The folders the person lets tools use, as the policy reads them.
 *
 * @remarks `any`: no folder is listed, so the folder rule is off and a call
 * may name any path. `listed`: a call may name a path only inside one of
 * `folderPaths`; the list is empty when the saved folders cannot be read, so
 * the rule fails closed and every path is outside.
 */
export type ApprovedFolders =
  | Readonly<{
      /** No folder is listed. */
      kind: "any"
    }>
  | Readonly<{
      /** Only the listed folders may be named. */
      kind: "listed"
      /**
       * Absolute paths of the folders, each resolved by text: without `.`
       * and `..` parts, repeated separators, or a separator at its end.
       */
      folderPaths: readonly string[]
    }>
  | Readonly<{
      /**
       * The settings file exists but its folders cannot be read, so no path
       * may be named until it is fixed.
       */
      kind: "unreadable"
    }>

/**
 * Reads the folders the person lets tools use, again on every call.
 *
 * @remarks Rejects only when the settings file cannot be closed.
 */
export type ReadApprovedFolders = () => Promise<ApprovedFolders>

/**
 * What the tool call rules need to know about this machine, and where they
 * read the person's choices from.
 *
 * @remarks Built once by `buildApp` from the backend configuration; the
 * paths are fixed for the backend's lifetime. Each decision uses the
 * {@link ToolCallRules} that {@link readToolCallRules} builds from it.
 */
export type ToolCallPolicy = Readonly<{
  /**
   * Absolute path of Lys's settings file, which holds its API keys and
   * passwords; a call naming it, or a copy of it that a stopped save left,
   * is denied.
   */
  settingsFilePath: string
  /**
   * Absolute path of the person's home folder: what `~` names, and the
   * folder a relative path is resolved against, because Lys starts MCP
   * servers in it.
   */
  homeFolderPath: string
  /** Reads the folders a call may name paths in. */
  readApprovedFolders: ReadApprovedFolders
}>

/**
 * What the rules decide one call by: the policy's paths and the approved
 * folders read for it.
 *
 * @remarks Read once for each round of tool calls, and again for the
 * re-check of a call the person allowed.
 */
export type ToolCallRules = Readonly<{
  /** As {@link ToolCallPolicy.settingsFilePath}. */
  settingsFilePath: string
  /** As {@link ToolCallPolicy.homeFolderPath}. */
  homeFolderPath: string
  /** The folders a call may name paths in, as read. */
  approvedFolders: ApprovedFolders
}>

/**
 * What the policy knows about one call: the attribute groups of the tool
 * authorization spec that its rules read, assembled by the gateway from what
 * the backend trusts, never from what the model claims.
 *
 * @remarks No rule reads an attribute of the subject (the agent), so the
 * request has none; a rule that needs one adds it.
 */
export type ToolCallRequest = Readonly<{
  /** What the call does: attributes of the tool it names. */
  action: Readonly<{
    /**
     * Whether the tool's MCP server marks it as one that may destroy data;
     * false for every tool of Lys's own and for an MCP tool its server does
     * not mark so.
     */
    isDestructive: boolean
    /**
     * Whether the tool's MCP server marks it as one that reaches beyond
     * Lys and this machine (`openWorldHint: true`) without marking it
     * read-only, such as one that sends an email; false for every tool of
     * Lys's own and for an MCP tool its server does not mark so.
     */
    isOpenWorldWrite: boolean
    /**
     * Whether a call spends a paid credit of the person's: true for
     * `web_search`, whose provider bills each search, and false otherwise.
     */
    isPaid: boolean
  }>
  /** What the call acts on. */
  resource: Readonly<{
    /** The call's arguments, after `AgentTool` checked their types. */
    arguments: ToolCallArguments
  }>
  /** The state the call is made in. */
  environment: Readonly<{
    /**
     * Number of earlier calls of the same tool in the call's reply, its
     * task, that the policy did not deny; a non-negative integer.
     */
    usageInTask: number
  }>
}>

/** Why the policy denied a call. */
export type ToolCallDenialReason =
  | "credential-file"
  | "outside-approved-folders"
  | "settings-unreadable"
  | "blocked-address"
  | "usage-limit"
  | "paid-tool-budget"

/** Why the policy requires the person's approval of a call. */
type ToolCallApprovalReason =
  "destructive-tool" | "open-world-write" | "paid-tool"

/**
 * The policy's answer for one call.
 *
 * @remarks `allow` leaves the call to the person's approval mode: Ask me
 * asks them, Just run runs it. `require-approval` asks the person in either
 * mode. `deny` means the call never runs and the person is never asked about
 * it, so no approval can override it.
 */
export type ToolCallDecision =
  | Readonly<{
      /** The call may go on to the approval mode. */
      effect: "allow"
    }>
  | Readonly<{
      /** The call runs only once the person allows it, whatever the mode. */
      effect: "require-approval"
      /** The rule that requires approval. */
      reason: ToolCallApprovalReason
    }>
  | Readonly<{
      /** The call never runs. */
      effect: "deny"
      /** The rule the call broke. */
      reason: ToolCallDenialReason
    }>

/**
 * Folder and file names, in lowercase, of `CREDENTIAL_FILE_LIST`, the list
 * the desktop's file tools refuse too.
 */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  ...CREDENTIAL_FILE_LIST.folderNames,
  ...CREDENTIAL_FILE_LIST.fileNames
])

/** Path parts of Lys's settings file a value must hold, in order. */
const SETTINGS_FILE_PART_COUNT = 2

/**
 * What follows the settings file's name in the name of the temporary copy
 * a save writes beside it: `.`, a process id, `.`, a number, and `.tmp`, as
 * `build_temporary_path` in the desktop's `src-tauri/src/settings.rs`
 * writes it. A save that stops midway leaves the copy, which holds the same
 * secrets; the shared cases in
 * `packages/share/test/fixtures/settings-file-copy-names.json` keep both
 * sides alike.
 */
const SETTINGS_FILE_COPY_ENDING_PATTERN = /^\.\d+\.\d+\.tmp$/u

/** A run of path separators, `/` or `\`. */
const PATH_SEPARATOR_PATTERN = /[/\\]+/u

/**
 * A separator, a carriage return, or a line feed between the lines of a
 * text, each line of which is read as a path on its own.
 */
const LINE_BREAK_PATTERN = /\r\n|\r|\n/u

/**
 * Start of a path a text names on this machine: `/` but not `//`, which
 * starts a network path; `~` alone or before `/`; or `.` or `..` alone or
 * before `/`.
 */
const LOCAL_PATH_START_PATTERN = /^(?:\/(?!\/)|~(?:\/|$)|\.\.?(?:\/|$))/u

/** Start of a path in the person's home folder: `~` alone or before `/`. */
const HOME_PATH_START_PATTERN = /^~(?=\/|$)/u

/** A percent escape of one byte: `%`, then the byte as two hex digits. */
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/giu

/** Any whitespace character. */
const WHITESPACE_PATTERN = /\s/u

/**
 * A host without a scheme, as a network path, an SSH or `scp` target, or an
 * address with a port writes it: an optional `//` or `\\`, an optional user
 * name up to the last `@`, which may hold an `@` of its own, then a name or
 * IPv4 address, or anything in brackets; then, optionally, `:`, `/`, or `\`
 * and anything after it, such as a port or a path.
 */
const BARE_HOST_PATTERN =
  /^(?:\/\/|\\\\)?(?:[^/\\]*@)?(?<host>\[[^\]]*\]|[^:/\\[\]@]+)(?:[:/\\].*)?$/u

/**
 * Identity of the rule set {@link decideToolCall} applies, stored with every
 * decision it makes; it changes whenever a rule or a limit changes, so a
 * stored decision names the rules that made it.
 */
export const TOOL_CALL_POLICY_ID = "lys-policy-v1"

/**
 * Number of calls of one tool one reply may make; a later call is denied.
 * High enough for a reply that reads many files, low enough to stop a model
 * that calls one tool in a loop.
 */
export const MAXIMUM_TOOL_CALLS_PER_TASK = 100

/**
 * Number of calls of a paid tool one reply makes in the person's approval
 * mode; each later call asks the person, even on Just run.
 */
export const PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL = 5

/**
 * Number of calls of a paid tool one reply may make, the most of the
 * person's paid credits one reply may spend; a later call is denied, even
 * one the person would allow.
 */
export const MAXIMUM_PAID_TOOL_CALLS_PER_TASK = 20

/** Folders when none is listed: the folder rule is off. */
const ANY_FOLDER: ApprovedFolders = Object.freeze({ kind: "any" })

/** Folders when the saved list cannot be read: no path may be named. */
const UNREADABLE_APPROVED_FOLDERS: ApprovedFolders = Object.freeze({
  kind: "unreadable"
})

/** Answer for a call no rule denies. */
const ALLOWED: ToolCallDecision = Object.freeze({ effect: "allow" })

/** Answer for a call naming a private key or credential file. */
const DENIED_CREDENTIAL_FILE: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "credential-file"
})

/** Answer for a call naming a path outside the approved folders. */
const DENIED_OUTSIDE_APPROVED_FOLDERS: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "outside-approved-folders"
})

/**
 * Answer for a call naming a path while the approved folders cannot be read
 * from the settings file.
 */
const DENIED_SETTINGS_UNREADABLE: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "settings-unreadable"
})

/** Answer for a call naming a blocked network address. */
const DENIED_BLOCKED_ADDRESS: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "blocked-address"
})

/** Answer for a call past the number of calls of one tool one reply may make. */
const DENIED_USAGE_LIMIT: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "usage-limit"
})

/** Answer for a paid tool's call past the calls one reply may make of it. */
const DENIED_PAID_TOOL_BUDGET: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "paid-tool-budget"
})

/** Answer for a call of a tool its MCP server marks as destructive. */
const DESTRUCTIVE_TOOL_APPROVAL_REQUIRED: ToolCallDecision = Object.freeze({
  effect: "require-approval",
  reason: "destructive-tool"
})

/**
 * Answer for a call of a tool its MCP server marks as reaching beyond Lys
 * and this machine without marking it read-only.
 */
const OPEN_WORLD_WRITE_APPROVAL_REQUIRED: ToolCallDecision = Object.freeze({
  effect: "require-approval",
  reason: "open-world-write"
})

/** Answer for a paid tool's call past the reply's calls without approval. */
const PAID_TOOL_APPROVAL_REQUIRED: ToolCallDecision = Object.freeze({
  effect: "require-approval",
  reason: "paid-tool"
})

/** Sentences the model reads for each denial, by reason. */
const DENIAL_MESSAGES = Object.freeze({
  "credential-file":
    "This call was denied and did not run: an argument names a private key or credential file, such as one under ~/.ssh or Lys's settings file, which no tool may use. Do not try to reach it another way; tell the person what you need it for.",
  "outside-approved-folders":
    "This call was denied and did not run: an argument names a file or folder outside the folders the person lets tools use. Do not try to reach it another way; tell the person which file you need, so they can add its folder in Settings if they agree.",
  "settings-unreadable":
    "This call was denied and did not run: an argument names a file or folder, and Lys cannot read the folders the person lets tools use, because its settings file cannot be read, so no file or folder may be named until the file is fixed. Do not try to reach it another way; tell the person that Lys's settings file cannot be read.",
  "blocked-address":
    "This call was denied and did not run: an argument names this machine, a private network, or another address Lys never connects to. Do not try to reach it another way; tell the person what you need it for.",
  "usage-limit": `This call was denied and did not run: this reply has already called this tool ${MAXIMUM_TOOL_CALLS_PER_TASK} times, the most one reply may. Do not call it again in this reply; tell the person what you found and what is left to do.`,
  "paid-tool-budget": `This call was denied and did not run: this reply has already called this tool ${MAXIMUM_PAID_TOOL_CALLS_PER_TASK} times, and each call spends the person's paid credits, so no reply may call it more. Do not call it again in this reply; work with the results you have and tell the person what is left to do.`
} satisfies Readonly<Record<ToolCallDenialReason, string>>)

/**
 * Lists every text of a call's arguments: the argument names, every string
 * value at any depth, and the keys of every nested object.
 *
 * @param callArguments - Checked arguments; they nest at most
 * `MAXIMUM_JSON_NESTING_DEPTH` levels deep, which bounds the walk.
 * @returns The texts, in no particular order.
 */
function listArgumentTexts(
  callArguments: ToolCallArguments
): readonly string[] {
  const texts: string[] = []
  const pendingValues: JsonValue[] = [callArguments]
  for (
    let value = pendingValues.pop();
    value !== undefined;
    value = pendingValues.pop()
  ) {
    if (typeof value === "string") {
      texts.push(value)
    } else if (isJsonArray(value)) {
      for (const item of value) pendingValues.push(item)
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        texts.push(key)
        pendingValues.push(item)
      }
    }
  }
  return texts
}

/**
 * Answers whether a JSON value is an array.
 *
 * @param value - Any JSON value.
 * @returns True for an array, which narrows the value to one.
 */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

/**
 * Splits a path into its parts, in lowercase.
 *
 * @param path - Any text; `/` and `\` both separate parts.
 * @returns The parts in order, without empty and `.` parts.
 */
function listPathParts(path: string): readonly string[] {
  return path
    .toLowerCase()
    .split(PATH_SEPARATOR_PATTERN)
    .filter((part) => part !== "" && part !== ".")
}

/**
 * Answers whether one path part names a private key or credential file, or
 * a folder of them.
 *
 * @param part - Lowercase path part.
 * @returns True for a folder or file name of `CREDENTIAL_FILE_LIST`, or a
 * name that starts with one of its starts or ends with one of its ends.
 */
function isCredentialPart(part: string): boolean {
  return (
    CREDENTIAL_NAMES.has(part) ||
    CREDENTIAL_FILE_LIST.fileNamePrefixes.some((prefix) =>
      part.startsWith(prefix)
    ) ||
    CREDENTIAL_FILE_LIST.fileNameEndings.some((ending) => part.endsWith(ending))
  )
}

/**
 * Answers whether a list of path parts holds another list, in order and
 * side by side.
 *
 * @param parts - Parts to search.
 * @param sequence - Parts to find; at least one.
 * @returns True when `sequence` appears in `parts`.
 */
function holdsPathSequence(
  parts: readonly string[],
  sequence: readonly string[]
): boolean {
  for (let start = 0; start + sequence.length <= parts.length; start += 1) {
    if (sequence.every((part, offset) => parts[start + offset] === part))
      return true
  }
  return false
}

/**
 * Reads a path part that names a leftover copy of Lys's settings file as
 * the settings file's name.
 *
 * @param part - Lowercase path part.
 * @param settingsFileName - Name of Lys's settings file, in lowercase.
 * @returns `settingsFileName` when `part` is that name followed by
 * `SETTINGS_FILE_COPY_ENDING_PATTERN`; otherwise `part`.
 */
function readCopyAsSettingsFileName(
  part: string,
  settingsFileName: string
): string {
  return part.startsWith(settingsFileName) &&
    SETTINGS_FILE_COPY_ENDING_PATTERN.test(part.slice(settingsFileName.length))
    ? settingsFileName
    : part
}

/**
 * Answers whether a path names a private key or credential file, a folder
 * of them, Lys's settings file, or a copy of it that a stopped save left.
 *
 * @param path - Path, or text that holds one.
 * @param settingsFileParts - Last parts of Lys's settings file path, in
 * lowercase: its folder and its name.
 * @returns True when one of its parts is a credential name, or its parts
 * hold `settingsFileParts`, a copy's name read as the settings file's.
 */
function namesCredentialPath(
  path: string,
  settingsFileParts: readonly string[]
): boolean {
  const parts = listPathParts(path)
  const settingsFileName = settingsFileParts.at(-1)
  const settingsParts =
    settingsFileName === undefined
      ? parts
      : parts.map((part) => readCopyAsSettingsFileName(part, settingsFileName))
  return (
    parts.some(isCredentialPart) ||
    holdsPathSequence(settingsParts, settingsFileParts)
  )
}

/**
 * Decodes every percent escape of a URL path.
 *
 * @param path - Path of a parsed URL.
 * @returns The path with each escape replaced by the character of its byte
 * value; a character outside ASCII comes out garbled, which leaves the
 * ASCII credential names intact.
 */
function decodePercentEscapes(path: string): string {
  return path.replaceAll(PERCENT_ESCAPE_PATTERN, (escape) =>
    String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
  )
}

/**
 * Answers whether a trimmed argument text names a private key or credential
 * file on this machine.
 *
 * @param text - Trimmed argument text.
 * @param settingsFileParts - Last parts of Lys's settings file path, in
 * lowercase.
 * @returns True when the text, read as a path, names one; a `file:` URL is
 * read by its decoded path. Any other URL with a host names a file on
 * another machine and is left to the address rule.
 */
function namesCredentialFile(
  text: string,
  settingsFileParts: readonly string[]
): boolean {
  const url = URL.parse(text)
  if (url === null) return namesCredentialPath(text, settingsFileParts)
  if (url.protocol === "file:")
    return namesCredentialPath(
      decodePercentEscapes(url.pathname),
      settingsFileParts
    )
  return url.host === "" && namesCredentialPath(text, settingsFileParts)
}

/**
 * Finds the path on this machine that one line of an argument text names.
 *
 * @param line - Trimmed line of an argument text.
 * @param homeFolderPath - Absolute path of the person's home folder.
 * @returns The path, absolute and resolved by text, for a `file:` URL, or
 * for a line that starts as {@link LOCAL_PATH_START_PATTERN} describes: `~`
 * names the home folder, and a relative path is resolved against it. Null
 * for a `file:` URL that names no path on this machine, such as one with a
 * host or an escaped `/`. Undefined for any other line, which names no path.
 */
function findLocalPath(
  line: string,
  homeFolderPath: string
): string | null | undefined {
  const url = URL.parse(line)
  if (url?.protocol === "file:") {
    try {
      return path.resolve(fileURLToPath(url))
    } catch {
      return null
    }
  }
  if (!LOCAL_PATH_START_PATTERN.test(line)) return undefined
  return path.resolve(
    homeFolderPath,
    line.replace(HOME_PATH_START_PATTERN, homeFolderPath)
  )
}

/**
 * Answers whether a path is one of the approved folders or inside one.
 *
 * @param localPath - Absolute path, resolved by text.
 * @param folderPaths - Absolute folder paths, resolved by text.
 * @returns True when the path equals a folder or lies below it by whole
 * parts, so `/work/app-old` is not inside `/work/app`. Case counts.
 */
function isInsideApprovedFolder(
  localPath: string,
  folderPaths: readonly string[]
): boolean {
  return folderPaths.some((folderPath) => {
    const relativePath = path.relative(folderPath, localPath)
    return (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  })
}

/**
 * Lists the paths on this machine that a trimmed argument text names, one
 * per line that names one.
 *
 * @param text - Trimmed argument text.
 * @param homeFolderPath - Absolute path of the person's home folder.
 * @returns Each path as {@link findLocalPath} finds it, null for a `file:`
 * URL that names no path on this machine; empty when no line names a path.
 */
function listLocalPaths(
  text: string,
  homeFolderPath: string
): readonly (string | null)[] {
  return text
    .split(LINE_BREAK_PATTERN)
    .map((line) => findLocalPath(line.trim(), homeFolderPath))
    .filter((localPath) => localPath !== undefined)
}

/**
 * Decides a call by the approved folders.
 *
 * @param texts - The call's trimmed argument texts.
 * @param rules - The home folder and the approved folders.
 * @returns Undefined when no folder is listed or no text names a path the
 * folders refuse; `deny` with `settings-unreadable` when a text names a path
 * while the folders cannot be read; otherwise `deny` with
 * `outside-approved-folders` when a text, or one of its lines, names a path
 * that is not inside a listed folder, a `file:` URL that names no path on
 * this machine included.
 */
function decideApprovedFolders(
  texts: readonly string[],
  rules: ToolCallRules
): ToolCallDecision | undefined {
  const { approvedFolders, homeFolderPath } = rules
  switch (approvedFolders.kind) {
    case "any":
      return undefined
    case "unreadable":
      return texts.some(
        (text) => listLocalPaths(text, homeFolderPath).length > 0
      )
        ? DENIED_SETTINGS_UNREADABLE
        : undefined
    case "listed":
      return texts.some((text) =>
        listLocalPaths(text, homeFolderPath).some(
          (localPath) =>
            localPath === null ||
            !isInsideApprovedFolder(localPath, approvedFolders.folderPaths)
        )
      )
        ? DENIED_OUTSIDE_APPROVED_FOLDERS
        : undefined
  }
}

/**
 * Answers whether a trimmed argument text is one URL or host that names this
 * machine or a blocked IP address.
 *
 * @param text - Trimmed argument text.
 * @returns True for a URL whose host, normalized as an `http` host, is a
 * local name or a blocked IP address, and for a local name or blocked IP
 * address in standard notation without a scheme, in any form
 * {@link BARE_HOST_PATTERN} reads, such as `admin@10.0.0.2`,
 * `\\10.0.0.5\share`, or `127.0.0.1:8080/api`. False for a text with
 * whitespace, such as a sentence or a command, and for any other name,
 * which is not looked up.
 */
function namesBlockedAddress(text: string): boolean {
  if (WHITESPACE_PATTERN.test(text)) return false
  const url = URL.parse(text)
  if (url !== null && url.host !== "") {
    // A host of a scheme the URL parser does not know, such as `postgres:`,
    // is left as written; parsing it as an `http` host normalizes odd
    // spellings of an IP address, such as `0x7f.1`, as a client would.
    const httpUrl = URL.parse(`http://${url.host}`)
    return httpUrl !== null && isLocalUrlHost(httpUrl.hostname)
  }
  if (isIP(text) === 6) return isLocalUrlHost(`[${text}]`)
  const host = BARE_HOST_PATTERN.exec(text)?.groups?.["host"]
  if (host === undefined) return false
  if (host.startsWith("["))
    return isIP(host.slice(1, -1)) === 6 && isLocalUrlHost(host)
  return isLocalUrlHost(host.toLowerCase())
}

/**
 * Decides one tool call by the rules, whatever the tool.
 *
 * @param request - What the gateway knows about the call.
 * @param rules - What the rules need to know about this machine and the
 * folders the person lets tools use.
 * @returns `deny` with `credential-file` when an argument text names a
 * private key or credential file, a folder of them, Lys's settings file, or
 * a copy of it that a stopped save left; otherwise `deny` with
 * `outside-approved-folders` when folders are listed
 * and an argument text, or a line of one, names a path outside them, or with
 * `settings-unreadable` when it names any path while the folders cannot be
 * read;
 * otherwise `deny` with `blocked-address` when an argument text is a URL or
 * host of this machine or a blocked IP address; otherwise `deny` with
 * `usage-limit` when the reply already made
 * {@link MAXIMUM_TOOL_CALLS_PER_TASK} calls of the tool that were not
 * denied, and with `paid-tool-budget` when the tool is paid and the reply
 * already made {@link MAXIMUM_PAID_TOOL_CALLS_PER_TASK} of them; otherwise
 * `require-approval` with `destructive-tool` when the tool is marked
 * destructive, with `open-world-write` when it is marked as reaching beyond
 * Lys and this machine and not read-only, and with `paid-tool` when it is
 * paid and the reply already made
 * {@link PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL} calls of it that were
 * not denied; otherwise `allow`. The deny rules come first, so a call that
 * breaks one is denied even when it would also need approval.
 * @remarks Reads argument texts only: it resolves no host name and follows
 * no symbolic link, and a text with whitespace is never read as an address.
 * A path is read only from a text, or a line of one, that starts as one; a
 * path inside a longer text, such as a command, and a relative path without
 * a leading `.` or `..`, such as `notes/a.txt`, are not read.
 * It does no I/O and throws nothing.
 */
export function decideToolCall(
  request: ToolCallRequest,
  rules: ToolCallRules
): ToolCallDecision {
  const texts = listArgumentTexts(request.resource.arguments).map((text) =>
    text.trim()
  )
  const settingsFileParts = listPathParts(rules.settingsFilePath).slice(
    -SETTINGS_FILE_PART_COUNT
  )
  if (texts.some((text) => namesCredentialFile(text, settingsFileParts)))
    return DENIED_CREDENTIAL_FILE
  const folderDecision = decideApprovedFolders(texts, rules)
  if (folderDecision !== undefined) return folderDecision
  if (texts.some(namesBlockedAddress)) return DENIED_BLOCKED_ADDRESS
  return decideUsageAndAction(request)
}

/**
 * Decides a call that names no forbidden path or address by its usage in
 * the reply and the marks of its tool.
 *
 * @param request - What the gateway knows about the call.
 * @returns As {@link decideToolCall} returns from its usage limit on.
 */
function decideUsageAndAction(request: ToolCallRequest): ToolCallDecision {
  const { action } = request
  const { usageInTask } = request.environment
  if (usageInTask >= MAXIMUM_TOOL_CALLS_PER_TASK) return DENIED_USAGE_LIMIT
  if (action.isPaid && usageInTask >= MAXIMUM_PAID_TOOL_CALLS_PER_TASK)
    return DENIED_PAID_TOOL_BUDGET
  if (action.isDestructive) return DESTRUCTIVE_TOOL_APPROVAL_REQUIRED
  if (action.isOpenWorldWrite) return OPEN_WORLD_WRITE_APPROVAL_REQUIRED
  if (action.isPaid && usageInTask >= PAID_TOOL_CALLS_PER_TASK_WITHOUT_APPROVAL)
    return PAID_TOOL_APPROVAL_REQUIRED
  return ALLOWED
}

/**
 * Reads what the rules decide calls by, now.
 *
 * @param policy - The machine's paths and the reader of the folders.
 * @returns A frozen snapshot holding the folders read just now.
 * @throws The reader's failure, when the settings file cannot be closed.
 */
export async function readToolCallRules(
  policy: ToolCallPolicy
): Promise<ToolCallRules> {
  const approvedFolders = await policy.readApprovedFolders()
  return Object.freeze({
    settingsFilePath: policy.settingsFilePath,
    homeFolderPath: policy.homeFolderPath,
    approvedFolders
  })
}

/**
 * Builds the folders the policy reads from what reading the settings file
 * found.
 *
 * @param read - The saved folders, or `unreadable`.
 * @returns `any` when no folder is saved; `listed` with each saved path
 * resolved by text; `unreadable` when the file cannot be read, so no path
 * may be named.
 */
export function buildApprovedFolders(
  read: ApprovedFoldersRead
): ApprovedFolders {
  if (read.status === "unreadable") return UNREADABLE_APPROVED_FOLDERS
  if (read.folderPaths.length === 0) return ANY_FOLDER
  return Object.freeze({
    kind: "listed",
    folderPaths: Object.freeze(
      read.folderPaths.map((folderPath) => path.resolve(folderPath))
    )
  })
}

/**
 * Formats the result the model reads for a denied call.
 *
 * @param reason - The rule the call broke.
 * @returns One paragraph saying the call did not run and why.
 */
export function formatToolCallDenial(reason: ToolCallDenialReason): string {
  return DENIAL_MESSAGES[reason]
}
