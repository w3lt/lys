import { mcpSettingsSchema, type McpSettings } from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the `mcp` group from the settings file found.
 *
 * @remarks `read`: the group passed its rules; no file and no group are the
 * declared forms of "no server" and read as an empty list. `invalid`: the
 * file is a JSON object whose `mcp` group fails its rules, with where and
 * why. `unreadable`: the file cannot be read, is larger than the limit
 * {@link readSettingsFileText} applies, is not UTF-8, or is not a JSON
 * object. A read or decode failure is never reported as no server.
 */
export type McpSettingsRead =
  | Readonly<{
      /** The group was read. */
      status: "read"
      /** The servers it holds, which can hold secrets. */
      settings: McpSettings
    }>
  | Readonly<{
      /** The group fails its rules. */
      status: "invalid"
      /**
       * Each failed rule as `<path>: <rule>`, such as
       * `servers.0.url: A URL starts with https://…`; never a value.
       */
      problems: readonly string[]
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/**
 * Validates the part of the settings document this reader uses.
 *
 * @remarks The desktop host owns and validates the whole document. This
 * reader takes only the `mcp` group; every other group is dropped unread, so
 * a group it does not know never makes the servers unreadable.
 */
const settingsMcpSchema = z.object({ mcp: z.unknown().optional() })

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: McpSettingsRead = Object.freeze({
  status: "unreadable"
})

/** Read result when there is no file or no `mcp` group. */
const NO_SERVERS: McpSettingsRead = Object.freeze({
  status: "read",
  settings: mcpSettingsSchema.parse({})
})

/**
 * Reads the `mcp` group from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link McpSettingsRead} describes. Each
 * call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. A JSON parse failure is dropped, because its message can
 * quote the text, which can hold secrets; a rule failure keeps only its path
 * and the rule's own message, never the value. The desktop host replaces the
 * file atomically, so a read sees a whole document.
 */
export async function readMcpSettings(
  settingsFilePath: string
): Promise<McpSettingsRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return NO_SERVERS
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseMcpSettings(file.text)
  }
}

/**
 * Parses the `mcp` group out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns `read`, `invalid`, or `unreadable` as {@link McpSettingsRead}
 * describes.
 */
function parseMcpSettings(text: string): McpSettingsRead {
  const document = parseSettingsDocument(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  if (document.mcp === undefined) return NO_SERVERS
  const parsed = mcpSettingsSchema.safeParse(document.mcp)
  if (parsed.success)
    return Object.freeze({ status: "read", settings: parsed.data })
  return Object.freeze({
    status: "invalid",
    problems: Object.freeze(parsed.error.issues.map(formatSettingsProblem))
  })
}

/**
 * Formats one failed rule of the `mcp` group.
 *
 * @param issue - Zod issue of the group's schema.
 * @returns `<path>: <message>`, the path joined with dots, or the message
 * alone for the group itself. The schema's messages name rules, never
 * values.
 */
function formatSettingsProblem(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".")
  return path === "" ? issue.message : `${path}: ${issue.message}`
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or not an
 * object.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseSettingsDocument(
  text: string
): z.infer<typeof settingsMcpSchema> | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = settingsMcpSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
