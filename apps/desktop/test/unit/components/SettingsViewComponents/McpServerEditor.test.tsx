import {
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  mcpServerSettingsSchema,
  type McpServerSettings
} from "@lys/share"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  McpServerEditor,
  type McpEditorTarget
} from "@/components/SettingsViewComponents/McpServerEditor"
import type { McpSettingsSaveState } from "@/lib/store/mcp-settings"
import { STORED_MCP_SETTINGS } from "../../support/settingsFixtures"

/** Names of no other saved server. */
const NO_OTHER_NAMES: ReadonlySet<string> = new Set()

/** Latest save of the servers before any save. */
const IDLE_SAVE: McpSettingsSaveState = Object.freeze({ status: "idle" })

/** A save of the servers that runs. */
const RUNNING_SAVE: McpSettingsSaveState = Object.freeze({ status: "saving" })

/** Reason of a failed save, as the application store gives it. */
const SAVE_FAILURE = "Lys couldn't write the MCP servers to its settings file."

/** A save of the servers that failed. */
const FAILED_SAVE: McpSettingsSaveState = Object.freeze({
  status: "failed",
  error: SAVE_FAILURE
})

/**
 * Gets one stored server.
 *
 * @param serverName - Name of a server of the stored settings.
 * @returns The server's settings.
 * @throws When the stored settings have no such server.
 */
function getStoredServer(serverName: string): McpServerSettings {
  const server = STORED_MCP_SETTINGS.servers.find(
    (stored) => stored.name === serverName
  )
  if (server === undefined) throw new Error(`No stored server ${serverName}`)
  return server
}

/** Editor of the stored `files` command server, with one variable. */
const FILES_TARGET: McpEditorTarget = Object.freeze({
  kind: "server",
  server: getStoredServer("files")
})

/** Editor of the stored `notes` URL server, signing in with a token. */
const NOTES_TARGET: McpEditorTarget = Object.freeze({
  kind: "server",
  server: getStoredServer("notes")
})

/** Variables of a server that sets as many as a server may. */
const MOST_VARIABLES = Array.from(
  { length: MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT },
  (_, index) => ({ name: `V${index}`, value: "v" })
)

/** Editor of a command server that sets as many variables as it may. */
const FULL_TARGET: McpEditorTarget = Object.freeze({
  kind: "server",
  server: mcpServerSettingsSchema.parse({
    name: "full",
    transport: "stdio",
    command: "/usr/bin/full",
    environment: MOST_VARIABLES
  })
})

/**
 * Renders one editor over spies for the parent's actions.
 *
 * @param target - What the editor is open for.
 * @param saveState - Latest save of the servers when it opens.
 * @returns The action spies and a way to give the editor a later save state.
 */
function startEditor(
  target: McpEditorTarget,
  saveState: McpSettingsSaveState = IDLE_SAVE
) {
  const onSaveServer = vi.fn<(server: McpServerSettings) => void>()
  const onClose = vi.fn<() => void>()
  const view = render(
    <McpServerEditor
      onClose={onClose}
      onSaveServer={onSaveServer}
      otherServerNames={NO_OTHER_NAMES}
      saveState={saveState}
      target={target}
    />
  )

  /**
   * Gives the editor the latest save of the servers, as its parent does.
   *
   * @param nextSaveState - Latest save of the servers.
   */
  function showSaveState(nextSaveState: McpSettingsSaveState): void {
    view.rerender(
      <McpServerEditor
        onClose={onClose}
        onSaveServer={onSaveServer}
        otherServerNames={NO_OTHER_NAMES}
        saveState={nextSaveState}
        target={target}
      />
    )
  }

  return { onSaveServer, onClose, showSaveState }
}

/**
 * Gets the editor form.
 *
 * @param formName - Name of the form: the server's, or `New MCP server`.
 * @returns The form.
 */
function getEditor(formName: string): HTMLElement {
  return screen.getByRole("form", { name: formName })
}

/**
 * Adds one row to a list of the editor and types its name and value.
 *
 * @param user - User-event session of the case.
 * @param form - Editor form.
 * @param itemName - What one row is called, such as `variable`.
 * @param name - Name the row takes; typed only when not empty.
 * @param value - Value the row takes; typed only when not empty.
 */
async function addRow(
  user: ReturnType<typeof userEvent.setup>,
  form: HTMLElement,
  itemName: string,
  name: string,
  value: string
): Promise<void> {
  await user.click(
    within(form).getByRole("button", { name: `add ${itemName}` })
  )
  if (name !== "") await user.keyboard(name)
  if (value !== "") await user.tab()
  if (value !== "") await user.keyboard(value)
}

describe("McpServerEditor", () => {
  it("names the back button by its visible text, and closes the editor with it", async () => {
    const { onClose } = startEditor(FILES_TARGET)
    const user = userEvent.setup()

    const back = within(getEditor("files")).getByRole("button", {
      name: "mcp servers"
    })
    expect(back).toHaveTextContent("mcp servers")
    await user.click(back)

    expect(onClose).toHaveBeenCalledOnce()
  })

  it("heads a list's rows with visible Name and Value labels that start each input's name, only while it has rows", async () => {
    startEditor(FILES_TARGET)
    const user = userEvent.setup()

    const environment = within(getEditor("files")).getByRole("group", {
      name: "Environment"
    })
    const nameHeading = within(environment).getByText("Name")
    const valueHeading = within(environment).getByText("Value")
    expect(within(environment).getByLabelText("Name of variable 1")).toBe(
      within(environment).getByRole("textbox", {
        name: `${nameHeading.textContent} of variable 1`
      })
    )
    expect(
      within(environment).getByLabelText(
        `${valueHeading.textContent} of variable 1`
      )
    ).toHaveValue("debug")

    await user.click(
      within(environment).getByRole("button", { name: "Remove variable 1" })
    )

    expect(within(environment).queryByText("Name")).toBeNull()
    expect(within(environment).queryByText("Value")).toBeNull()
  })

  it("marks a repeated variable's name invalid, names its row in the problem, and focuses it on Save", async () => {
    const { onSaveServer } = startEditor(FILES_TARGET)
    const user = userEvent.setup()
    const form = getEditor("files")

    await addRow(user, form, "variable", "LOG_LEVEL", "info")
    await user.click(within(form).getByRole("button", { name: "Save" }))

    const repeatedName = within(form).getByRole("textbox", {
      name: "Name of variable 2"
    })
    expect(repeatedName).toHaveFocus()
    expect(repeatedName).toHaveAttribute("aria-invalid", "true")
    expect(repeatedName).toHaveAccessibleDescription(
      "Variable 2: A server sets each environment variable once."
    )
    expect(
      within(form).getByRole("textbox", { name: "Name of variable 1" })
    ).toHaveAttribute("aria-invalid", "false")
    expect(within(form).getByLabelText("Value of variable 2")).toHaveAttribute(
      "aria-invalid",
      "false"
    )
    expect(onSaveServer).not.toHaveBeenCalled()

    await user.clear(repeatedName)
    await user.keyboard("LOG_FORMAT")

    expect(repeatedName).toHaveAttribute("aria-invalid", "false")
    expect(repeatedName).not.toHaveAccessibleDescription()
  })

  it("marks a header value that breaks the header rule invalid and focuses it on Save", async () => {
    startEditor(NOTES_TARGET)
    const user = userEvent.setup()
    const form = getEditor("notes")

    await addRow(user, form, "header", "X-Team", "café")
    await user.click(within(form).getByRole("button", { name: "Save" }))

    const value = within(form).getByLabelText("Value of header 1")
    expect(value).toHaveFocus()
    expect(value).toHaveAttribute("aria-invalid", "true")
    expect(value).toHaveAccessibleDescription(
      "Header 1: A header value is visible ASCII characters, spaces, and tabs, with no space or tab at either end."
    )
    expect(
      within(form).getByRole("textbox", { name: "Name of header 1" })
    ).toHaveAttribute("aria-invalid", "false")
  })

  it("marks an Authorization header row beside the token invalid and focuses its name on Save", async () => {
    startEditor(NOTES_TARGET)
    const user = userEvent.setup()
    const form = getEditor("notes")

    await addRow(user, form, "header", "X-Team", "a")
    await addRow(user, form, "header", "authorization", "Basic xyz")
    await user.click(within(form).getByRole("button", { name: "Save" }))

    const authorization = within(form).getByRole("textbox", {
      name: "Name of header 2"
    })
    expect(authorization).toHaveFocus()
    expect(authorization).toHaveAttribute("aria-invalid", "true")
    expect(authorization).toHaveAccessibleDescription(
      "Header 2: The token is sent as the Authorization header. Remove this header, or set sign-in to None."
    )
  })

  it("leads from a summary entry of a list to the row input its problem concerns", async () => {
    startEditor(FILES_TARGET)
    const user = userEvent.setup()
    const form = getEditor("files")

    await user.clear(within(form).getByRole("textbox", { name: "Command" }))
    await addRow(user, form, "variable", "1BAD", "")
    await user.click(within(form).getByRole("button", { name: "Save" }))

    const summary = within(form).getByRole("group", {
      name: "Fix 2 fields to save:"
    })
    expect(summary).toHaveFocus()
    await user.click(
      within(summary).getByRole("button", {
        name: /^Environment: Variable 2: /
      })
    )

    expect(
      within(form).getByRole("textbox", { name: "Name of variable 2" })
    ).toHaveFocus()
  })

  it("focuses the list itself for a problem of the whole list, marking no row invalid", async () => {
    startEditor(FULL_TARGET)
    const user = userEvent.setup()
    const form = getEditor("full")

    await addRow(user, form, "variable", "ONE_MORE", "v")
    await user.click(within(form).getByRole("button", { name: "Save" }))

    const environment = within(form).getByRole("group", {
      name: "Environment"
    })
    expect(environment).toHaveFocus()
    expect(environment).toHaveAccessibleDescription(
      expect.stringMatching(
        new RegExp(
          `A server sets at most ${MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT} environment variables\\.$`,
          "u"
        )
      )
    )
    expect(
      within(environment)
        .getAllByRole("textbox")
        .filter((input) => input.getAttribute("aria-invalid") === "true")
    ).toEqual([])
  })

  it("saves on Ctrl Enter from any field", () => {
    const { onSaveServer } = startEditor(FILES_TARGET)

    fireEvent.keyDown(within(getEditor("files")).getByLabelText("Command"), {
      key: "Enter",
      ctrlKey: true
    })

    expect(onSaveServer).toHaveBeenCalledExactlyOnceWith(
      getStoredServer("files")
    )
  })

  it("leaves Escape and ⌘ Enter to an input method while it composes text", () => {
    const { onSaveServer, onClose } = startEditor(FILES_TARGET)
    const name = within(getEditor("files")).getByRole("textbox", {
      name: "Name"
    })

    fireEvent.keyDown(name, { key: "Escape", isComposing: true })
    fireEvent.keyDown(name, { key: "Enter", metaKey: true, isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
    expect(onSaveServer).not.toHaveBeenCalled()

    fireEvent.keyDown(name, { key: "Escape" })

    expect(onClose).toHaveBeenCalledOnce()
  })

  it("ignores Escape, ⌘ Enter, and a submission while a save runs, with the fields read-only and every action disabled", () => {
    const { onSaveServer, onClose } = startEditor(FILES_TARGET, RUNNING_SAVE)
    const form = getEditor("files")
    const name = within(form).getByRole("textbox", { name: "Name" })

    fireEvent.keyDown(name, { key: "Escape" })
    fireEvent.keyDown(name, { key: "Enter", metaKey: true })
    fireEvent.submit(form)

    expect(onClose).not.toHaveBeenCalled()
    expect(onSaveServer).not.toHaveBeenCalled()
    expect(name).toHaveAttribute("readonly")
    expect(within(form).getByRole("status")).toHaveTextContent("Saving…")
    for (const action of ["mcp servers", "Cancel", "Save"]) {
      expect(within(form).getByRole("button", { name: action })).toBeDisabled()
    }
  })

  it("shows only the failure of a save this editor sent", async () => {
    const { onSaveServer, showSaveState } = startEditor(
      FILES_TARGET,
      FAILED_SAVE
    )
    const user = userEvent.setup()
    const form = getEditor("files")

    expect(within(form).getByRole("alert")).toHaveTextContent("")

    await user.click(within(form).getByRole("button", { name: "Save" }))
    showSaveState(RUNNING_SAVE)
    showSaveState(FAILED_SAVE)

    expect(onSaveServer).toHaveBeenCalledOnce()
    expect(within(form).getByRole("alert")).toHaveTextContent(SAVE_FAILURE)
    expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled()
  })
})
