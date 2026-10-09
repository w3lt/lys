import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  startAgentBackend,
  type AgentBackendOptions
} from "../../support/agentBackend"
import { buildAgent } from "../../support/agentFixtures"
import { buildJsonResponse } from "../../support/backendFake"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Stored agent the cases edit. */
const RESEARCHER = buildAgent("researcher", {
  name: "Researcher",
  bio: "Finds sources.",
  systemPrompt: "You are researcher."
})

/**
 * Renders the Agents pane over a backend storing the given agents.
 *
 * @param options - Backend options; the inventory read is always answered.
 * @returns The agent backend.
 */
async function startAgentPane(options: AgentBackendOptions = {}) {
  const agentBackend = startAgentBackend([RESEARCHER], {
    ...options,
    routes: { [INVENTORY_ROUTE]: buildInventoryRoute(), ...options.routes }
  })
  const { SettingsView } = await loadFreshSettingsView("agents")
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByText(/^Saved by the backend in Lys's database/)
  await waitForRenderedWork()
  return agentBackend
}

/**
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function waitForRenderedWork(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
}

/**
 * Opens the new-agent editor from the list.
 *
 * @param user - User-event session of the case.
 * @returns The editor form.
 */
async function openNewAgentEditor(
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "New agent" }))
  return screen.getByRole("form", { name: "New agent" })
}

/**
 * Opens the stored agent's editor from the list.
 *
 * @param user - User-event session of the case.
 * @returns The editor form.
 */
async function openResearcherEditor(
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  await user.click(
    screen.getByRole("button", { name: "Researcher researcher" })
  )
  await waitForRenderedWork()
  return screen.getByRole("form", { name: "Researcher" })
}

/**
 * Gets one editor field by its label.
 *
 * @param label - Visible label of the field.
 * @returns The field.
 */
function getField(label: "name" | "code" | "bio" | "system prompt") {
  return screen.getByRole("textbox", { name: label })
}

/**
 * Fills a new agent's required fields.
 *
 * @param user - User-event session of the case.
 * @param fields - Text typed into each field.
 */
async function updateNewAgentFields(
  user: ReturnType<typeof userEvent.setup>,
  fields: {
    readonly name: string
    readonly bio: string
    readonly prompt: string
  }
): Promise<void> {
  await user.type(getField("name"), fields.name)
  await user.type(getField("bio"), fields.bio)
  await user.type(getField("system prompt"), fields.prompt)
}

describe("AgentEditor", () => {
  describe("a new agent", () => {
    it("starts on the name field of an empty form whose code is assigned on save", async () => {
      await startAgentPane()
      const user = userEvent.setup()

      const form = await openNewAgentEditor(user)

      expect(getField("name")).toHaveFocus()
      expect(getField("name")).toBeRequired()
      expect(getField("bio")).toBeRequired()
      expect(getField("system prompt")).toBeRequired()
      expect(getField("code")).not.toBeRequired()
      expect(getField("code")).toHaveAccessibleDescription(
        "optional · fixed once created lowercase letters and digits, joined by single hyphens, not ending in one 0 / 64"
      )
      expect(form).toHaveTextContent("newcode assigned on save")
      expect(
        within(form).getByRole("button", { name: "Create" })
      ).toBeDisabled()
      expect(within(form).getByRole("button", { name: "Close" })).toBeEnabled()
    })

    it("marks a started draft unsaved, measures its name, and offers the name's code form", async () => {
      await startAgentPane()
      const user = userEvent.setup()
      const form = await openNewAgentEditor(user)

      await user.type(getField("name"), "  Code Reviewer ")

      expect(form).toHaveTextContent(/^.*unsavednewcode assigned on save/)
      expect(getField("name")).toHaveAccessibleDescription("13 / 64")
      expect(
        within(form).getByRole("button", { name: "Discard" })
      ).toBeEnabled()
      expect(within(form).getByRole("button", { name: "Create" })).toBeEnabled()

      await user.click(within(form).getByRole("button", { name: "use name" }))

      expect(getField("code")).toHaveValue("code-reviewer")
      expect(form).toHaveTextContent("newcode-reviewer")
      expect(
        within(form).queryByRole("button", { name: "use name" })
      ).toBeNull()
    })

    it("refuses to create a draft with a problem, explaining it at the field and focusing it", async () => {
      const { backend } = await startAgentPane()
      const user = userEvent.setup()
      await openNewAgentEditor(user)
      await user.type(getField("name"), "Reviewer")
      await user.type(getField("system prompt"), "You review.")

      await user.click(screen.getByRole("button", { name: "Create" }))

      const bio = getField("bio")
      expect(bio).toHaveFocus()
      expect(bio).toBeInvalid()
      expect(bio).toHaveAccessibleDescription(
        "0 / 128 Give the agent a one-line bio."
      )
      expect(getField("name")).toBeValid()
      expect(
        backend.requests.filter((request) => request.method === "POST")
      ).toEqual([])
    })

    it("refuses a name another agent already has", async () => {
      await startAgentPane()
      const user = userEvent.setup()
      await openNewAgentEditor(user)
      await updateNewAgentFields(user, {
        name: "researcher",
        bio: "Another one.",
        prompt: "You research."
      })

      await user.click(screen.getByRole("button", { name: "Create" }))

      expect(getField("name")).toHaveFocus()
      expect(
        screen.getByText(
          "Another agent already goes by researcher. Pick another name."
        )
      ).toBeInTheDocument()
    })

    it("creates the agent and returns to the list with its row focused and marked saved", async () => {
      const { backend } = await startAgentPane({ createdCodes: ["reviewer"] })
      const user = userEvent.setup()
      await openNewAgentEditor(user)
      await updateNewAgentFields(user, {
        name: " Reviewer ",
        bio: "Reads diffs.",
        prompt: "You review code."
      })
      await user.type(getField("code"), "reviewer")

      await user.click(screen.getByRole("button", { name: "Create" }))
      await waitForRenderedWork()

      expect(
        backend.requests.find((request) => request.method === "POST")?.body
      ).toEqual({
        code: "reviewer",
        name: "Reviewer",
        bio: "Reads diffs.",
        systemPrompt: "You review code."
      })
      const row = screen.getByRole("button", { name: "Reviewer reviewer" })
      expect(row).toHaveFocus()
      expect(row).toHaveAccessibleDescription("Reads diffs. saved")
    })

    it("lets the backend derive the code when none is typed", async () => {
      const { backend } = await startAgentPane({ derivedCode: "reviewer" })
      const user = userEvent.setup()
      await openNewAgentEditor(user)
      await updateNewAgentFields(user, {
        name: "Reviewer",
        bio: "Reads diffs.",
        prompt: "You review code."
      })

      await user.click(screen.getByRole("button", { name: "Create" }))
      await waitForRenderedWork()

      expect(
        backend.requests.find((request) => request.method === "POST")?.body
      ).not.toHaveProperty("code")
      expect(
        screen.getByRole("button", { name: "Reviewer reviewer" })
      ).toHaveFocus()
    })

    it.each([
      ["Command", { metaKey: true }],
      ["Control", { ctrlKey: true }]
    ])(
      "creates with %s+Enter from the system prompt",
      async (_key, modifier) => {
        const { backend } = await startAgentPane({
          createdCodes: ["reviewer"]
        })
        const user = userEvent.setup()
        await openNewAgentEditor(user)
        await updateNewAgentFields(user, {
          name: "Reviewer",
          bio: "Reads diffs.",
          prompt: "You review code."
        })
        await user.type(getField("code"), "reviewer")

        fireEvent.keyDown(getField("system prompt"), {
          key: "Enter",
          ...modifier
        })
        await waitForRenderedWork()

        expect(
          backend.requests.filter((request) => request.method === "POST")
        ).toHaveLength(1)
      }
    )

    it("discards the draft on Escape without a request", async () => {
      const { backend } = await startAgentPane()
      const user = userEvent.setup()
      await openNewAgentEditor(user)
      await user.type(getField("name"), "Reviewer")

      await user.keyboard("{Escape}")

      expect(screen.queryByRole("form")).toBeNull()
      expect(screen.getByRole("button", { name: "New agent" })).toHaveFocus()
      expect(
        backend.requests.filter((request) => request.method !== "GET")
      ).toEqual([])
    })
  })

  describe("a stored agent", () => {
    it("shows the stored fields, without a code field, and saves nothing until changed", async () => {
      await startAgentPane()
      const user = userEvent.setup()

      const form = await openResearcherEditor(user)

      expect(getField("name")).toHaveValue("Researcher")
      expect(getField("bio")).toHaveValue("Finds sources.")
      expect(getField("system prompt")).toHaveValue("You are researcher.")
      expect(screen.queryByRole("textbox", { name: "code" })).toBeNull()
      expect(form).toHaveTextContent("yoursresearcher")
      expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled()
    })

    it("ignores the save shortcut while nothing changed", async () => {
      const { backend } = await startAgentPane()
      const user = userEvent.setup()
      await openResearcherEditor(user)

      fireEvent.keyDown(getField("bio"), { key: "Enter", metaKey: true })
      await waitForRenderedWork()

      expect(
        backend.requests.filter((request) => request.method === "PATCH")
      ).toEqual([])
      expect(
        screen.getByRole("form", { name: "Researcher" })
      ).toBeInTheDocument()
    })

    it("measures the system prompt as an estimate of the context window", async () => {
      await startAgentPane()
      const user = userEvent.setup()
      await openResearcherEditor(user)

      expect(getField("system prompt")).toHaveAccessibleDescription(
        "19 chars · ~6 tokens · 0.0% of 33k"
      )
    })

    it("saves a changed field and returns to the list with the row focused", async () => {
      const { backend } = await startAgentPane()
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)

      await user.clear(getField("bio"))
      await user.type(getField("bio"), "Finds and checks sources.")
      expect(form).toHaveTextContent(/^.*unsavedyours/)
      await user.click(within(form).getByRole("button", { name: "Save" }))
      await waitForRenderedWork()

      expect(
        backend.requests.find((request) => request.method === "PATCH")?.body
      ).toMatchObject({ bio: "Finds and checks sources." })
      const row = screen.getByRole("button", { name: "Researcher researcher" })
      expect(row).toHaveFocus()
      expect(row).toHaveAccessibleDescription("Finds and checks sources. saved")
    })

    it("locks the editor while a save is pending", async () => {
      const save = createControlledPromise<Response>()
      await startAgentPane({
        routes: { "PATCH /api/v1/agents/researcher": () => save.promise }
      })
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)
      await user.type(getField("bio"), "!")

      await user.click(within(form).getByRole("button", { name: "Save" }))
      await waitForRenderedWork()

      expect(within(form).getByText("Saving…")).toHaveAttribute(
        "role",
        "status"
      )
      expect(getField("bio")).toHaveAttribute("readonly")
      for (const name of [
        "agents list",
        "Discard",
        "Save",
        "Delete",
        "Duplicate"
      ]) {
        expect(within(form).getByRole("button", { name })).toBeDisabled()
      }
      await user.keyboard("{Escape}")
      expect(
        screen.getByRole("form", { name: "Researcher" })
      ).toBeInTheDocument()

      save.resolve(
        buildJsonResponse(
          200,
          buildAgent("researcher", {
            name: "Researcher",
            bio: "Finds sources.!",
            systemPrompt: "You are researcher."
          })
        )
      )
      await waitForRenderedWork()
    })

    it("alerts a failed save and keeps the draft editable", async () => {
      await startAgentPane({
        routes: {
          "PATCH /api/v1/agents/researcher": () =>
            new Response(null, { status: 500 })
        }
      })
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)
      await user.type(getField("bio"), "!")

      await user.click(within(form).getByRole("button", { name: "Save" }))
      await waitForRenderedWork()

      expect(within(form).getByRole("alert")).not.toBeEmptyDOMElement()
      expect(getField("bio")).not.toHaveAttribute("readonly")
      expect(getField("bio")).toHaveValue("Finds sources.!")
    })

    it("asks before deleting, starting on Keep, and keeps the agent on Escape", async () => {
      await startAgentPane()
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)

      await user.click(within(form).getByRole("button", { name: "Delete" }))

      const confirmation = within(form).getByRole("group", {
        name: "Delete for good?"
      })
      expect(
        within(confirmation).getByRole("button", { name: "Keep" })
      ).toHaveFocus()

      await user.keyboard("{Escape}")

      expect(within(form).queryByRole("group")).toBeNull()
      expect(within(form).getByRole("button", { name: "Delete" })).toHaveFocus()
    })

    it("deletes the agent and returns to the list with New agent focused", async () => {
      const { listStoredAgents } = await startAgentPane()
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)
      await user.click(within(form).getByRole("button", { name: "Delete" }))

      await user.click(
        within(
          within(form).getByRole("group", { name: "Delete for good?" })
        ).getByRole("button", { name: "Delete" })
      )
      await waitForRenderedWork()

      expect(listStoredAgents()).toEqual([])
      expect(screen.queryByRole("button", { name: /^Researcher/ })).toBeNull()
      expect(screen.getByRole("button", { name: "New agent" })).toHaveFocus()
    })

    it("focuses the created copy, not the agent it was copied from, back in the list", async () => {
      await startAgentPane({ createdCodes: ["researcher-copy"] })
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)
      await user.click(within(form).getByRole("button", { name: "Duplicate" }))

      await user.type(getField("code"), "researcher-copy")
      await user.click(screen.getByRole("button", { name: "Create" }))
      await waitForRenderedWork()

      expect(
        screen.getByRole("button", { name: "Researcher copy researcher-copy" })
      ).toHaveFocus()
    })

    it("opens a copy as a new agent under another name", async () => {
      await startAgentPane()
      const user = userEvent.setup()
      const form = await openResearcherEditor(user)

      await user.click(within(form).getByRole("button", { name: "Duplicate" }))

      expect(
        screen.getByRole("form", { name: "New agent" })
      ).toBeInTheDocument()
      expect(getField("name")).toHaveValue("Researcher copy")
      expect(getField("bio")).toHaveValue("Finds sources.")
      expect(getField("system prompt")).toHaveValue("You are researcher.")
    })
  })
})
