import { toolNameSchema } from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the tools saved as Just run from the settings file found.
 *
 * @remarks `read`: the saved names, each passing the shared tool-name rule;
 * empty when there is no file, no `tools` group, or no `justRun` list, which
 * are the declared forms of "no tool on Just run". Names of tools the backend
 * does not offer are kept; they match no call. `unreadable`: the file cannot
 * be read, is larger than the limit {@link readSettingsFileText} applies, is
 * not UTF-8, is not a JSON object, or its `tools` group or `justRun` list is
 * `null` or holds anything but valid names. A read or decode failure is never
 * reported as an empty list.
 */
export type JustRunToolNamesRead =
  | Readonly<{
      /** The saved choices were read. */
      status: "read"
      /** Names of the tools on Just run; owned by the caller. */
      toolNames: ReadonlySet<string>
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/**
 * Validates the part of the settings document this reader uses.
 *
 * @remarks The desktop host owns and validates the whole document. This
 * reader takes only `tools.justRun`; every other group and field is dropped
 * unread, so a group or field it does not know never makes the list
 * unreadable.
 */
const settingsToolsSchema = z.object({
  tools: z.object({ justRun: z.array(toolNameSchema).optional() }).optional()
})

/** The part of the settings document this reader uses. */
type SettingsTools = z.infer<typeof settingsToolsSchema>

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: JustRunToolNamesRead = Object.freeze({
  status: "unreadable"
})

/** Names read when no tool is saved as Just run. */
const NO_JUST_RUN_TOOL_NAMES: readonly string[] = Object.freeze([])

/**
 * Reads the tools saved as Just run from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link JustRunToolNamesRead} describes.
 * Each call reads the file again, so a choice the desktop saved applies to
 * the next read.
 * @throws Only when closing the opened file fails.
 * @remarks Never writes. Parse failures are dropped, because JSON parse
 * messages quote the text, which can hold the saved secrets.
 */
export async function readJustRunToolNames(
  settingsFilePath: string
): Promise<JustRunToolNamesRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return buildJustRunToolNamesRead(NO_JUST_RUN_TOOL_NAMES)
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseJustRunToolNames(file.text)
  }
}

/**
 * Parses the saved names out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns `read` or `unreadable` as {@link JustRunToolNamesRead} describes.
 */
function parseJustRunToolNames(text: string): JustRunToolNamesRead {
  const document = parseSettingsTools(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  return buildJustRunToolNamesRead(
    document.tools?.justRun ?? NO_JUST_RUN_TOOL_NAMES
  )
}

/**
 * Builds the read result of the saved names.
 *
 * @param toolNames - Validated names; a repeated name counts once.
 * @returns A frozen `read` result holding a new set.
 */
function buildJustRunToolNamesRead(
  toolNames: readonly string[]
): JustRunToolNamesRead {
  return Object.freeze({ status: "read", toolNames: new Set(toolNames) })
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or the part is
 * invalid.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseSettingsTools(text: string): SettingsTools | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = settingsToolsSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
