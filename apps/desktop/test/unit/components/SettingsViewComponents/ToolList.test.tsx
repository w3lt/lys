import type { ComponentProps } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ToolGroupSection } from "@/components/SettingsViewComponents/ToolList"
import {
  buildToolGroups,
  calculateToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import type { ToolChoice } from "@/lib/store/tools"
import { buildToolDefinition } from "../../support/toolFixtures"

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

/**
 * Renders the group with spies for every proposal.
 *
 * @param props - Group facts the case varies.
 * @returns The proposal spies.
 */
function renderToolGroup(
  props: Partial<ComponentProps<typeof ToolGroupSection>> = {}
) {
  const proposals = {
    onExpandedToolNameChange: vi.fn(),
    onToolOnChange: vi.fn(),
    onToolApprovalChange: vi.fn()
  }
  render(
    <ToolGroupSection
      expandedToolName={null}
      isDimmed={false}
      isLocked={false}
      listing={FILES_GROUP}
      toolChoices={new Map()}
      {...proposals}
      {...props}
    />
  )
  return proposals
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
    renderToolGroup({
      toolChoices: new Map<string, ToolChoice>([
        ["list_roots", { isOn: false, approval: "run" }]
      ])
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
    renderToolGroup()

    const toggle = getToolToggle("read_text_file")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveAccessibleDescription(
      "reads in Lys Runs read_text_file."
    )
    const row = toggle.closest("li") as HTMLElement
    expect(row).toHaveTextContent(
      `~${calculateToolTokenEstimate(READ_TEXT_FILE)} tok`
    )
    expect(
      within(row).getByRole("switch", { name: "Use read_text_file" })
    ).toBeChecked()
  })

  it("notes a tool that is on and asks before it runs", () => {
    renderToolGroup({
      toolChoices: new Map<string, ToolChoice>([
        ["read_text_file", { isOn: true, approval: "ask" }],
        ["list_roots", { isOn: false, approval: "ask" }]
      ])
    })

    expect(getToolToggle("read_text_file")).toHaveAccessibleDescription(
      "reads in Lys Runs read_text_file. asks before it runs"
    )
    expect(getToolToggle("list_roots")).toHaveAccessibleDescription(
      "reads in Lys Runs list_roots."
    )
  })

  it("proposes expanding a collapsed row", async () => {
    const collapsed = renderToolGroup()
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))

    expect(collapsed.onExpandedToolNameChange).toHaveBeenCalledExactlyOnceWith(
      "read_text_file"
    )
  })

  it("collapses an expanded row on request", async () => {
    const expanded = renderToolGroup({ expandedToolName: "read_text_file" })
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))

    expect(expanded.onExpandedToolNameChange).toHaveBeenCalledExactlyOnceWith(
      null
    )
  })

  it("shows an expanded tool's arguments, where it runs, and its approval", () => {
    renderToolGroup({ expandedToolName: "read_text_file" })

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
    expect(
      within(argumentsSection).getByText("path").closest("li")
    ).toHaveTextContent(/^pathstringrequiredAbsolute file path\.$/)
    expect(
      within(argumentsSection).getByText("encoding").closest("li")
    ).toHaveTextContent(/^encodingenum · 2optionalText encoding\.utf-8latin1$/)
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
      "Runs the moment the model asks for it."
    )
    expect(
      within(approval).getByRole("button", { name: "Just run" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(getToolToggle("list_roots")).not.toHaveAttribute("aria-controls")
  })

  it("says when an expanded tool takes no arguments", () => {
    renderToolGroup({ expandedToolName: "list_roots" })

    expect(screen.getByRole("region", { name: "arguments" })).toHaveTextContent(
      "argumentsnoneTakes no arguments."
    )
  })

  it("proposes switching a tool off and another approval, but not the current one", async () => {
    const proposals = renderToolGroup({ expandedToolName: "read_text_file" })
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Use read_text_file" }))
    await user.click(screen.getByRole("button", { name: "Just run" }))
    await user.click(screen.getByRole("button", { name: "Ask me" }))

    expect(proposals.onToolOnChange).toHaveBeenCalledExactlyOnceWith(
      "read_text_file",
      false
    )
    expect(proposals.onToolApprovalChange).toHaveBeenCalledExactlyOnceWith(
      "read_text_file",
      "ask"
    )
  })

  it("disables every control while locked", async () => {
    const proposals = renderToolGroup({
      expandedToolName: "read_text_file",
      isLocked: true
    })
    const user = userEvent.setup()

    await user.click(getToolToggle("read_text_file"))
    await user.click(screen.getByRole("switch", { name: "Use read_text_file" }))
    await user.click(screen.getByRole("button", { name: "Ask me" }))

    expect(getToolToggle("read_text_file")).toBeDisabled()
    expect(proposals.onExpandedToolNameChange).not.toHaveBeenCalled()
    expect(proposals.onToolOnChange).not.toHaveBeenCalled()
    expect(proposals.onToolApprovalChange).not.toHaveBeenCalled()
  })
})
