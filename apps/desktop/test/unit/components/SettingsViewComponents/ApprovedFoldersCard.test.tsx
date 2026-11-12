import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ApprovedFoldersCard from "@/components/SettingsViewComponents/ApprovedFoldersCard"

/** What the field says for a path that is not an absolute folder path. */
const INVALID_PATH_MESSAGE =
  "Type an absolute path that starts with /, such as /Users/you/Projects, in at most 1024 characters, without tabs or other control characters."

/**
 * Renders the card for a list of folders, with spies for its requests.
 *
 * @param folderPaths - Folders the card lists.
 * @returns The spies.
 */
function renderCard(folderPaths: readonly string[] = []) {
  const onAddFolder = vi.fn<(folderPath: string) => void>()
  const onRemoveFolder = vi.fn<(folderPath: string) => void>()
  render(
    <ApprovedFoldersCard
      folderPaths={folderPaths}
      onAddFolder={onAddFolder}
      onRemoveFolder={onRemoveFolder}
    />
  )
  return { onAddFolder, onRemoveFolder }
}

describe("ApprovedFoldersCard", () => {
  it("says tools may use any file while no folder is listed, and offers no Add before a path is typed", () => {
    renderCard()

    expect(
      screen.getByText(/No folder listed: tools may use any file Lys can read/)
    ).toBeInTheDocument()
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add folder" })).toBeDisabled()
  })

  it("lists each folder with a Remove button named for it", () => {
    renderCard(["/Users/ada/work", "/srv/shared"])

    const list = screen.getByRole("list", { name: "Folders tools may use" })
    expect(list).toHaveTextContent("/Users/ada/work")
    expect(list).toHaveTextContent("/srv/shared")
    expect(
      screen.getByRole("button", { name: "Remove /srv/shared" })
    ).toBeInTheDocument()
  })

  it("adds the trimmed path on Enter and empties the field", async () => {
    const user = userEvent.setup()
    const { onAddFolder } = renderCard()
    const field = screen.getByRole("textbox", { name: "Folder" })

    await user.type(field, "  /Users/ada/My Documents  {Enter}")

    expect(onAddFolder.mock.calls).toEqual([["/Users/ada/My Documents"]])
    expect(field).toHaveValue("")
  })

  it.each(
    Object.entries({
      "a relative path": "work/app",
      "a path in the home folder's form": "~/work",
      "a path that is too long": `/${"a".repeat(1024)}`,
      "a path holding a tab": "/Users/ada/a\tb"
    })
  )(
    "refuses %s with Add folder, says why, and keeps it until the person types again",
    async (_label, typedPath) => {
      const user = userEvent.setup()
      const { onAddFolder } = renderCard()
      const field = screen.getByRole("textbox", { name: "Folder" })
      await user.click(field)
      await user.paste(typedPath)

      await user.click(screen.getByRole("button", { name: "Add folder" }))

      expect(onAddFolder).not.toHaveBeenCalled()
      expect(field).toHaveValue(typedPath)
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveAccessibleDescription(INVALID_PATH_MESSAGE)
      await user.type(field, "x")
      expect(field).not.toHaveAttribute("aria-invalid")
      expect(screen.queryByText(INVALID_PATH_MESSAGE)).not.toBeInTheDocument()
    }
  )

  it("refuses a folder already listed", async () => {
    const user = userEvent.setup()
    const { onAddFolder } = renderCard(["/srv/shared"])

    await user.type(
      screen.getByRole("textbox", { name: "Folder" }),
      "/srv/shared{Enter}"
    )

    expect(onAddFolder).not.toHaveBeenCalled()
    expect(
      screen.getByRole("textbox", { name: "Folder" })
    ).toHaveAccessibleDescription("This folder is already listed.")
  })

  it("asks to remove a folder and moves focus to the field", async () => {
    const user = userEvent.setup()
    const { onRemoveFolder } = renderCard(["/Users/ada/work", "/srv/shared"])

    await user.click(
      screen.getByRole("button", { name: "Remove /Users/ada/work" })
    )

    expect(onRemoveFolder.mock.calls).toEqual([["/Users/ada/work"]])
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveFocus()
  })
})
