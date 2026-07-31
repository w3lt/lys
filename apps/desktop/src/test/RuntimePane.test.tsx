import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Suspense } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import RuntimePaneContent from "@/components/SettingsViewComponents/RuntimePaneContent"
import { formatUptime } from "@/lib/hooks/useUptime"

const invoke = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke }))

function renderPane() {
  return render(
    <Suspense fallback={null}>
      <RuntimePaneContent />
    </Suspense>
  )
}

describe("runtime pane", () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation((command: string) =>
      command === "load_settings"
        ? Promise.resolve({
            autoStartBackend: true,
            selectedModel: "qwen3-8b-instruct"
          })
        : Promise.resolve()
    )
  })

  it("offers both backend actions and enables only the available one", async () => {
    renderPane()

    expect(await screen.findByText("Backend stopped")).toBeInTheDocument()
    expect(
      screen.getByText("127.0.0.1:12345 · not running")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled()
  })

  it("reports the address and uptime once the backend runs", async () => {
    const user = userEvent.setup()
    renderPane()
    await screen.findByText("Backend stopped")

    await user.click(screen.getByRole("button", { name: "Start" }))

    expect(invoke).toHaveBeenCalledWith("start_backend")
    expect(screen.getByText("Backend running")).toBeInTheDocument()
    expect(screen.getByText("127.0.0.1:12345 · up 0s")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled()
  })

  it("carries automatic start inside the backend card", async () => {
    const user = userEvent.setup()
    renderPane()
    await screen.findByText("Backend stopped")

    const autoStart = screen.getByRole("switch", {
      name: "Start it when Lys opens"
    })
    expect(autoStart).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("On")).toBeInTheDocument()

    await user.click(autoStart)

    expect(autoStart).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText("Off")).toBeInTheDocument()
  })

  it("names the selected weights while model loading stays unavailable", async () => {
    renderPane()
    await screen.findByText("No model loaded")

    expect(
      screen.getByText("qwen3-8b-instruct selected · not in memory")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
  })
})

describe("uptime formatting", () => {
  it("reports seconds alone under a minute", () => {
    expect(formatUptime(0)).toBe("0s")
    expect(formatUptime(18_400)).toBe("18s")
  })

  it("keeps counting in minutes past an hour", () => {
    expect(formatUptime(60_000)).toBe("1m 0s")
    expect(formatUptime(42_678_000)).toBe("711m 18s")
  })

  it("never reports negative time from a clock that moved", () => {
    expect(formatUptime(-5_000)).toBe("0s")
  })
})
