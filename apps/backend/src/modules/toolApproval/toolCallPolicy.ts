import type { ChatToolCall } from "@lys/protocol"
import type { JsonValue } from "@lys/share"
import { isIP } from "node:net"
import { isLocalUrlHost } from "../tool/builtIn/web/webAddresses"

/** Arguments of one call, after `AgentTool` checked their types. */
type ToolCallArguments = ChatToolCall["arguments"]

/**
 * What the fixed tool call rules need to know about this machine.
 *
 * @remarks Built once by `buildApp` from the backend configuration and
 * fixed for the backend's lifetime; no setting changes it.
 */
export type ToolCallPolicy = Readonly<{
  /**
   * Absolute path of Lys's settings file, which holds its API keys and
   * passwords; a call naming it is denied.
   */
  settingsFilePath: string
}>

/**
 * What the policy knows about one call: the attribute groups of the tool
 * authorization spec that its rules read, assembled by the gateway from what
 * the backend trusts, never from what the model claims.
 *
 * @remarks No rule reads an attribute of the subject (the agent) or the
 * environment (the conversation), so the request has none; a rule that needs
 * one adds it.
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
  }>
  /** What the call acts on. */
  resource: Readonly<{
    /** The call's arguments, after `AgentTool` checked their types. */
    arguments: ToolCallArguments
  }>
}>

/** Why the policy denied a call. */
export type ToolCallDenialReason = "credential-file" | "blocked-address"

/** Why the policy requires the person's approval of a call. */
export type ToolCallApprovalReason = "destructive-tool"

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
 * Folders, in lowercase, whose every file is treated as a private key or
 * credential: SSH, GnuPG, AWS, Azure, Kubernetes, and Docker settings, and
 * the macOS keychains.
 */
const CREDENTIAL_FOLDER_NAMES: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  "keychains"
])

/**
 * File names, in lowercase, of private keys and of files that hold
 * passwords or tokens: SSH keys, `.netrc` files, the PostgreSQL password
 * file, Git's stored credentials, npm and PyPI settings, Apache password
 * files, and `.env` files.
 */
const CREDENTIAL_FILE_NAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
  ".env"
])

/** Start, in lowercase, of the names of `.env` files for one environment. */
const ENVIRONMENT_FILE_PREFIX = ".env."

/**
 * File name endings, in lowercase, of private keys, certificates with their
 * keys, keystores, and password databases.
 */
const KEY_FILE_EXTENSIONS: readonly string[] = Object.freeze([
  ".pem",
  ".key",
  ".p8",
  ".p12",
  ".pfx",
  ".ppk",
  ".jks",
  ".keystore",
  ".kdbx"
])

/** Path parts of Lys's settings file a value must hold, in order. */
const SETTINGS_FILE_PART_COUNT = 2

/** A run of path separators, `/` or `\`. */
const PATH_SEPARATOR_PATTERN = /[/\\]+/u

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

/** Answer for a call no rule denies. */
const ALLOWED: ToolCallDecision = Object.freeze({ effect: "allow" })

/** Answer for a call naming a private key or credential file. */
const DENIED_CREDENTIAL_FILE: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "credential-file"
})

/** Answer for a call naming a blocked network address. */
const DENIED_BLOCKED_ADDRESS: ToolCallDecision = Object.freeze({
  effect: "deny",
  reason: "blocked-address"
})

/** Answer for a call of a tool its MCP server marks as destructive. */
const DESTRUCTIVE_TOOL_APPROVAL_REQUIRED: ToolCallDecision = Object.freeze({
  effect: "require-approval",
  reason: "destructive-tool"
})

/** Sentences the model reads for each denial, by reason. */
const DENIAL_MESSAGES = Object.freeze({
  "credential-file":
    "This call was denied and did not run: an argument names a private key or credential file, such as one under ~/.ssh or Lys's settings file, which no tool may use. Do not try to reach it another way; tell the person what you need it for.",
  "blocked-address":
    "This call was denied and did not run: an argument names this machine, a private network, or another address Lys never connects to. Do not try to reach it another way; tell the person what you need it for."
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
 * @returns True for a credential folder or file name, a `.env.` file name,
 * or a name ending in a key file extension.
 */
function isCredentialPart(part: string): boolean {
  return (
    CREDENTIAL_FOLDER_NAMES.has(part) ||
    CREDENTIAL_FILE_NAMES.has(part) ||
    part.startsWith(ENVIRONMENT_FILE_PREFIX) ||
    KEY_FILE_EXTENSIONS.some((extension) => part.endsWith(extension))
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
 * Answers whether a path names a private key or credential file, a folder
 * of them, or Lys's settings file.
 *
 * @param path - Path, or text that holds one.
 * @param settingsFileParts - Last parts of Lys's settings file path, in
 * lowercase: its folder and its name.
 * @returns True when one of its parts is a credential name, or its parts
 * hold `settingsFileParts`.
 */
function namesCredentialPath(
  path: string,
  settingsFileParts: readonly string[]
): boolean {
  const parts = listPathParts(path)
  return (
    parts.some(isCredentialPart) || holdsPathSequence(parts, settingsFileParts)
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
 * Decides one tool call by the fixed rules, whatever the tool.
 *
 * @param request - What the gateway knows about the call.
 * @param policy - What the rules need to know about this machine.
 * @returns `deny` with `credential-file` when an argument text names a
 * private key or credential file, a folder of them, or Lys's settings file;
 * otherwise `deny` with `blocked-address` when an argument text is a URL or
 * host of this machine or a blocked IP address; otherwise `require-approval`
 * with `destructive-tool` when the tool is marked destructive; otherwise
 * `allow`. The deny rules come first, so a call that breaks one is denied
 * even when it would also need approval.
 * @remarks Reads argument texts only: it resolves no host name and follows
 * no symbolic link, and a text with whitespace is never read as an address.
 * It does no I/O and throws nothing.
 */
export function decideToolCall(
  request: ToolCallRequest,
  policy: ToolCallPolicy
): ToolCallDecision {
  const texts = listArgumentTexts(request.resource.arguments).map((text) =>
    text.trim()
  )
  const settingsFileParts = listPathParts(policy.settingsFilePath).slice(
    -SETTINGS_FILE_PART_COUNT
  )
  if (texts.some((text) => namesCredentialFile(text, settingsFileParts)))
    return DENIED_CREDENTIAL_FILE
  if (texts.some(namesBlockedAddress)) return DENIED_BLOCKED_ADDRESS
  if (request.action.isDestructive) return DESTRUCTIVE_TOOL_APPROVAL_REQUIRED
  return ALLOWED
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
