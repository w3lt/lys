import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { buildBuiltInAgent } from "../../support/agentFixtures"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  READY_RUNTIME,
  updateStoreRuntime,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"

/** Built-in agent the view shows, with a 23-character system prompt. */
const CALIGINIA = buildBuiltInAgent(CALIGINIA_AGENT_CODE, {
  name: "Caliginia",
  bio: "Plain answers.",
  systemPrompt: "You answer plainly now."
})

/**
 * Loads a fresh application store and the view that reads it, and renders
 * the view of {@link CALIGINIA}.
 *
 * @param runtime - Backend, LM Studio, and model facts in the store; by
 * default a loaded model with an 8,192-token context.
 * @returns The recorders of the two requests.
 */
async function startBuiltInAgentView(
  runtime: RuntimeArrangement = READY_RUNTIME
) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { default: BuiltInAgentView } =
    await import("@/components/SettingsViewComponents/BuiltInAgentView")
  updateStoreRuntime(useLysStore, runtime)
  const requests = { onCloseAgentView: vi.fn(), onDuplicateAgent: vi.fn() }
  render(<BuiltInAgentView agent={CALIGINIA} {...requests} />)
  return requests
}

/**
 * Lists the controls on which Escape returns to the agent list.
 *
 * @returns The back button, the three fields, and the two footer buttons.
 */
function listViewControls(): HTMLElement[] {
  return [
    screen.getByRole("button", { name: "agents list" }),
    screen.getByRole("textbox", { name: "name" }),
    screen.getByRole("textbox", { name: "bio" }),
    screen.getByRole("textbox", { name: "system prompt" }),
    screen.getByRole("button", { name: "Duplicate" }),
    screen.getByRole("button", { name: "Close" })
  ]
}

describe("BuiltInAgentView", () => {
  it("shows the agent's identity, name, bio, and prompt in a region named after it, with focus on the way back", async () => {
    await startBuiltInAgentView()

    const view = screen.getByRole("region", { name: "Caliginia" })
    expect(view).toHaveTextContent(`built-in${CALIGINIA_AGENT_CODE}`)
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue(
      "Caliginia"
    )
    expect(screen.getByRole("textbox", { name: "bio" })).toHaveValue(
      "Plain answers."
    )
    expect(screen.getByRole("textbox", { name: "system prompt" })).toHaveValue(
      "You answer plainly now."
    )
    expect(screen.getByRole("button", { name: "agents list" })).toHaveFocus()
  })

  it("measures the prompt against the context length the loaded model reports, as the prompt field's description", async () => {
    await startBuiltInAgentView({
      ...READY_RUNTIME,
      modelInventory: {
        status: "ready",
        modelLoading: "lys",
        models: [
          buildLlmInfo("qwen3-8b", { loaded: true, loadedContextLength: 4096 })
        ]
      }
    })

    expect(
      screen.getByRole("textbox", { name: "system prompt" })
    ).toHaveAccessibleDescription(
      /^23 chars · ~\d+ tokens · \d+\.\d% of 4\.1k$/
    )
  })

  it("leaves the window share out of the measure while no model is loaded", async () => {
    await startBuiltInAgentView({
      ...READY_RUNTIME,
      modelInventory: {
        status: "ready",
        modelLoading: "lys",
        models: [buildLlmInfo("qwen3-8b")]
      }
    })

    expect(
      screen.getByRole("textbox", { name: "system prompt" })
    ).toHaveAccessibleDescription(/^23 chars · ~\d+ tokens$/)
  })

  it("lets no field be typed into, and does not spell-check the prompt", async () => {
    await startBuiltInAgentView()
    const user = userEvent.setup()
    const fields = [
      screen.getByRole("textbox", { name: "name" }),
      screen.getByRole("textbox", { name: "bio" }),
      screen.getByRole("textbox", { name: "system prompt" })
    ]

    for (const field of fields) {
      await user.type(field, " changed")
    }

    expect(fields[0]).toHaveValue("Caliginia")
    expect(fields[1]).toHaveValue("Plain answers.")
    expect(fields[2]).toHaveValue("You answer plainly now.")
    expect(fields.map((field) => field.hasAttribute("readonly"))).toEqual([
      true,
      true,
      true
    ])
    expect(fields[2]).toHaveAttribute("spellcheck", "false")
  })

  it("offers a copy and a way back, and neither a save nor a delete", async () => {
    const requests = await startBuiltInAgentView()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Duplicate" }))
    const closesAfterDuplicate = requests.onCloseAgentView.mock.calls.length
    await user.click(screen.getByRole("button", { name: "Close" }))
    await user.click(screen.getByRole("button", { name: "agents list" }))

    expect(requests.onDuplicateAgent).toHaveBeenCalledOnce()
    expect(closesAfterDuplicate).toBe(0)
    expect(requests.onCloseAgentView).toHaveBeenCalledTimes(2)
    expect(
      screen.getAllByRole("button").map((button) => button.textContent)
    ).toEqual(["agents", "Duplicate", "Close"])
    expect(screen.getByText("built-in · not editable")).toBeInTheDocument()
  })

  it("returns to the agent list on Escape from each of its fields and buttons", async () => {
    const requests = await startBuiltInAgentView()

    const controls = listViewControls()
    controls.forEach((control) => {
      fireEvent.keyDown(control, { key: "Escape" })
    })

    expect(requests.onCloseAgentView).toHaveBeenCalledTimes(controls.length)
    expect(requests.onDuplicateAgent).not.toHaveBeenCalled()
  })

  it("stays open on other keys, and on an Escape that ends text composition", async () => {
    const requests = await startBuiltInAgentView()

    listViewControls().forEach((control) => {
      fireEvent.keyDown(control, { key: "Enter" })
      fireEvent.keyDown(control, { key: "Escape", isComposing: true })
    })

    expect(requests.onCloseAgentView).not.toHaveBeenCalled()
  })
})
