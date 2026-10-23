import type { BackendToolUnavailableReason } from "@lys/protocol"
import type { ComponentProps } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ToolGroupSection } from "@/components/SettingsViewComponents/ToolList"
import {
  buildToolGroups,
  calculateToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import type { ToolSettings } from "@/lib/store/settings"
import {
  buildBackendToolDefinition,
  buildToolDefinition
} from "../../support/toolFixtures"

/** Tool with one required path and an optional enum. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file", [
  { type: "string", name: "path", description: "Absolute file path." },
  {
    type: "enum",
    name: "encoding",
    description: "Text encoding.",
    required: false,
    values: ["utf-8", "latin1"]
  }
])

/** Tool without arguments. */
const LIST_ROOTS = buildToolDefinition("list_roots", [])

/** The files group listing both tools. */
const [FILES_GROUP] = buildToolGroups([READ_TEXT_FILE, LIST_ROOTS])

/** Tool the backend runs; it sends requests off this machine. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** The web group listing the backend's tool. */
const [WEB_GROUP] = buildToolGroups([READ_PAGE])

/** Backend tool that can lack what it needs to run. */
const WEB_SEARCH = buildBackendToolDefinition("web_search")

/** The web group listing both backend tools. */
const [SEARCH_GROUP] = buildToolGroups([READ_PAGE, WEB_SEARCH])

/**
 * Builds the choices the rows are drawn with.
 *
 * @param switches - Tools the person switched on or off, by name.
 * @param justRunToolNames - Tools saved as Just run.
 * @returns The choices.
 */
function buildToolChoices(
  switches: Readonly<Record<string, boolean>>,
  justRunToolNames: readonly string[]
): ToolSettings {
  return {
    switches: new Map(Object.entries(switches)),
    justRunToolNames: new Set(justRunToolNames)
  }
}

/** Choices that switch both backend tools on and let `read_page` run at once. */
const BACKEND_TOOLS_ON = buildToolChoices(
  { read_page: true, web_search: true },
  ["read_page"]
)

/** `read_page` unavailable while vmo, Lys's page reader, isn't ready. */
const PAGE_READER_NOT_READY: ReadonlyMap<string, BackendToolUnavailableReason> =
  new Map([["read_page", "page-reader-not-ready"]])

/**
 * Renders the group with spies for every proposal.
 *
 * @param props - Group facts the case varies.
 * @returns The proposal spies.
 */
function startToolGroup(
  props: Partial<ComponentProps<typeof ToolGroupSection>> = {}
) {
  const proposals = {
    onExpandedToolNameChange: vi.fn(),
    onToolOnChange: vi.fn(),
    onToolApprovalChange: vi.fn(),
    onOpenSecrets: vi.fn()
  }
  render(
    <ToolGroupSection
      expandedToolName={null}
      isDimmed={false}
      isLocked={false}
      listing={FILES_GROUP}
      toolChoices={buildToolChoices({}, [])}
      unavailableTools={new Map()}
      {...proposals}
      {...props}
    />
  )
  return proposals
}

/**
 * Gets the list item of one tool's row: the item holding the tool's switch.
 *
 * @param toolName - Tool whose row is wanted.
 * @returns The row.
 * @throws When no listed item holds that tool's switch.
 */
function getToolRow(toolName: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((item) =>
      within(item).queryByRole("switch", { name: `Use ${toolName}` })
    )
  if (row === undefined) throw new Error(`No row holds ${toolName}'s switch`)
  return row
}

/**
 * Gets the list item of one argument: the item whose visible text begins
 * with the argument's name.
 *
 * @param argumentsSection - Region listing a tool's arguments.
 * @param argumentName - Argument whose item is wanted.
 * @returns The argument's item.
 * @throws When no item in the region begins with that name.
 */
function getArgumentItem(
  argumentsSection: HTMLElement,
  argumentName: string
): HTMLElement {
  const item = within(argumentsSection)
    .getAllByRole("listitem")
    .find((listItem) => listItem.textContent?.startsWith(argumentName))
  if (item === undefined) throw new Error(`No item lists ${argumentName}`)
  return item
}

/**
 * Gets the button that expands a tool's row.
 *
 * @param toolName - Name of the tool.
 * @returns The expand button, named by the tool's name.
 */
function getToolToggle(toolName: string): HTMLElement {
  return screen.getByRole("button", { name: toolName })
}

describe("ToolGroupSection", () => {
  it("lists the group's tools under its heading with how many are on", () => {
    startToolGroup({
      toolChoices: buildToolChoices({ list_roots: false }, ["list_roots"])
    })

    const section = screen.getByRole("region", { name: "files" })
    expect(section).toHaveTextContent(/^files1 of 2 on/)
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((row) => within(row).getAllByRole("button")[0])
    ).toEqual([getToolToggle("read_text_file"), getToolToggle("list_roots")])
  })

  it("describes each tool's row with its badges and description, beside its estimate and switch", () => {
    startToolGroup()

    const toggle = getToolToggle("read_text_file")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    // A tool the person has not changed is on and asks before each call.
    expect(toggle).toHaveAccessibleDescription(
      "reads in Lys Runs read_text_file. asks before it runs"
    )
    const row = getToolRow("read_text_file")
    expect(row).toHaveTextContent(
      `~${calculateToolTokenEstimate(READ_TEXT_FILE)} tok`
    )
    expect(
      within(row).getByRole("switch", { name: "Use read_text_file" })
    ).toBeChecked()
  })

  it.each<[string, ToolSettings, string]>([
    [
      "on and asks first",
      buildToolChoices({ read_text_file: true }, []),
      "reads in Lys Runs read_text_file. asks before it runs"
    ],
    [
      "on and runs at once",
      buildToolChoices({ read_text_file: true }, ["read_text_file"]),
      "reads in Lys Runs read_text_file."
    ],
    [
      "off, though it would ask first",
      buildToolChoices({ read_text_file: false }, []),
      "reads in Lys Runs read_text_file."
    ]
  ])(
    "notes that a tool asks before it runs only while it is on and asks: %s",
    (_case, toolChoices, description) => {
      startToolGroup({ toolChoices })

      expect(getToolToggle("read_text_file")).toHaveAccessibleDescription(
        description
      )
    }
  )

  it("proposes expanding a collapsed row", async () => {
    const collapsed = startToolGroup()
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))

    expect(collapsed.onExpandedToolNameChange).toHaveBeenCalledExactlyOnceWith(
      "read_text_file"
    )
  })

  it("collapses an expanded row on request", async () => {
    const expanded = startToolGroup({ expandedToolName: "read_text_file" })
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))

    expect(expanded.onExpandedToolNameChange).toHaveBeenCalledExactlyOnceWith(
      null
    )
  })

  it("shows an expanded tool's arguments, where it runs, and its approval", () => {
    startToolGroup({ expandedToolName: "read_text_file" })

    const toggle = getToolToggle("read_text_file")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const details = document.getElementById(
      toggle.getAttribute("aria-controls") ?? ""
    )
    if (details === null) throw new Error("The tool details are not shown")
    const argumentsSection = within(details).getByRole("region", {
      name: "arguments"
    })
    expect(argumentsSection).toHaveTextContent(
      "arguments1 required · 1 optional"
    )
    expect(getArgumentItem(argumentsSection, "path")).toHaveTextContent(
      /^pathstringrequiredAbsolute file path\.$/
    )
    expect(getArgumentItem(argumentsSection, "encoding")).toHaveTextContent(
      /^encodingenum · 2optionalText encoding\.utf-8latin1$/
    )
    expect(
      within(
        within(argumentsSection).getByRole("list", { name: "Accepted values" })
      )
        .getAllByRole("listitem")
        .map((value) => value.textContent)
    ).toEqual(["utf-8", "latin1"])
    expect(details).toHaveTextContent("Runs in Lys")
    const approval = within(details).getByRole("group", {
      name: "Before it runs"
    })
    expect(approval).toHaveAccessibleDescription(
      "Each call waits for you with its arguments. Nothing runs until you allow it."
    )
    expect(
      within(approval).getByRole("button", { name: "Ask me" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(
      within(approval).getByRole("button", { name: "Just run" })
    ).toHaveAttribute("aria-pressed", "false")
    expect(getToolToggle("list_roots")).not.toHaveAttribute("aria-controls")
  })

  it("shows a backend tool as running in the backend, off until switched on", () => {
    startToolGroup({ listing: WEB_GROUP, expandedToolName: "read_page" })

    const toggle = getToolToggle("read_page")
    expect(toggle).toHaveAccessibleDescription(
      "network in backend Runs read_page in the backend."
    )
    expect(
      screen.getByRole("switch", { name: "Use read_page" })
    ).not.toBeChecked()
    const details = document.getElementById(
      toggle.getAttribute("aria-controls") ?? ""
    )
    expect(details).toHaveTextContent("Runs in Lys’s backend")
    expect(details).toHaveTextContent(
      "Handled by Lys’s backend, which sends the request from wherever it runs."
    )
  })

  it("says that a backend tool on Just run sends its request without showing it", () => {
    startToolGroup({
      listing: WEB_GROUP,
      expandedToolName: "read_page",
      toolChoices: BACKEND_TOOLS_ON
    })

    const approval = screen.getByRole("group", { name: "Before it runs" })
    expect(approval).toHaveAccessibleDescription(
      "Sends its request off this machine the moment the model asks, without showing you what it sends."
    )
    expect(
      within(approval).getByRole("button", { name: "Just run" })
    ).toHaveAttribute("aria-pressed", "true")
  })

  it("says when an expanded tool takes no arguments", () => {
    startToolGroup({ expandedToolName: "list_roots" })

    expect(screen.getByRole("region", { name: "arguments" })).toHaveTextContent(
      "argumentsnoneTakes no arguments."
    )
  })

  it("proposes switching a tool off and another approval, but not the current one", async () => {
    const proposals = startToolGroup({ expandedToolName: "read_text_file" })
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Use read_text_file" }))
    await user.click(screen.getByRole("button", { name: "Just run" }))
    await user.click(screen.getByRole("button", { name: "Ask me" }))

    expect(proposals.onToolOnChange).toHaveBeenCalledExactlyOnceWith(
      READ_TEXT_FILE,
      false
    )
    expect(proposals.onToolApprovalChange).toHaveBeenCalledExactlyOnceWith(
      READ_TEXT_FILE,
      "run"
    )
  })

  it("shows a switched-on tool that cannot run now as off, disabled, and not counted, with why", async () => {
    const proposals = startToolGroup({
      listing: SEARCH_GROUP,
      toolChoices: BACKEND_TOOLS_ON,
      unavailableTools: new Map([["web_search", "api-key-invalid"]])
    })
    const user = userEvent.setup()

    const section = screen.getByRole("region", { name: "web" })
    expect(section).toHaveTextContent(/^web1 of 2 on/)
    const toolSwitch = screen.getByRole("switch", { name: "Use web_search" })
    await user.click(toolSwitch)
    expect(proposals.onToolOnChange).not.toHaveBeenCalled()
    expect(toolSwitch).not.toBeChecked()
    expect(toolSwitch).toHaveAttribute("aria-disabled", "true")
    expect(toolSwitch).toHaveAccessibleDescription(
      "The Tavily API key in settings.json isn't valid. Fix or remove secrets.tavilyApiKey in that file."
    )
    // A tool that cannot run is not offered, so it does not ask either.
    expect(getToolToggle("web_search")).toHaveAccessibleDescription(
      "network in backend Runs web_search in the backend."
    )
    expect(
      within(getToolRow("web_search")).queryByRole("button", {
        name: "Open Secrets"
      })
    ).toBeNull()
    expect(
      screen.getByRole("switch", { name: "Use read_page" })
    ).toHaveAccessibleDescription("")
  })

  it("offers to open the Secrets pane for a missing key", async () => {
    const proposals = startToolGroup({
      listing: SEARCH_GROUP,
      toolChoices: BACKEND_TOOLS_ON,
      unavailableTools: new Map([["web_search", "api-key-missing"]])
    })
    const user = userEvent.setup()

    expect(
      screen.getByRole("switch", { name: "Use web_search" })
    ).toHaveAccessibleDescription(
      "Needs a Tavily API key. Add one in Settings → Secrets. Open Secrets"
    )
    await user.click(screen.getByRole("button", { name: "Open Secrets" }))

    expect(proposals.onOpenSecrets).toHaveBeenCalledOnce()
    expect(proposals.onToolOnChange).not.toHaveBeenCalled()
  })

  it("names an unreadable settings file without a button, since the pane cannot fix it", () => {
    startToolGroup({
      listing: SEARCH_GROUP,
      toolChoices: BACKEND_TOOLS_ON,
      unavailableTools: new Map([["web_search", "settings-unreadable"]])
    })

    expect(
      screen.getByRole("switch", { name: "Use web_search" })
    ).toHaveAccessibleDescription(
      "Lys couldn't read settings.json. Fix that file by hand."
    )
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull()
  })

  it("shows read_page off and disabled while vmo isn't ready, pointing to the Runtime pane", async () => {
    const proposals = startToolGroup({
      listing: SEARCH_GROUP,
      toolChoices: BACKEND_TOOLS_ON,
      unavailableTools: PAGE_READER_NOT_READY
    })
    const user = userEvent.setup()

    const toolSwitch = screen.getByRole("switch", { name: "Use read_page" })
    await user.click(toolSwitch)

    expect(proposals.onToolOnChange).not.toHaveBeenCalled()
    expect(toolSwitch).not.toBeChecked()
    expect(toolSwitch).toHaveAttribute("aria-disabled", "true")
    expect(toolSwitch).toHaveAccessibleDescription(
      "vmo, Lys's page reader, isn't ready. See Settings → Runtime."
    )
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull()
  })

  it("disables every control while locked", async () => {
    const proposals = startToolGroup({
      expandedToolName: "read_text_file",
      isLocked: true
    })
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))
    await user.click(screen.getByRole("switch", { name: "Use read_text_file" }))
    // Just run is the approval the tool does not have, so only the lock can
    // keep it from being proposed.
    await user.click(screen.getByRole("button", { name: "Just run" }))

    expect(getToolToggle("read_text_file")).toBeDisabled()
    expect(proposals.onExpandedToolNameChange).not.toHaveBeenCalled()
    expect(proposals.onToolOnChange).not.toHaveBeenCalled()
    expect(proposals.onToolApprovalChange).not.toHaveBeenCalled()
  })
})
