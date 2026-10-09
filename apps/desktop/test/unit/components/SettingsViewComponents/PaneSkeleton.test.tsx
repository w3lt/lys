import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { SettingsPane } from "@/app/types"
import PaneSkeleton from "@/components/SettingsViewComponents/PaneSkeleton"

describe("PaneSkeleton", () => {
  it.each<SettingsPane>(["runtime", "model", "generation", "agents", "tools"])(
    "announces once, politely, that the %s settings are being read",
    (pane) => {
      render(<PaneSkeleton pane={pane} />)

      const status = screen.getByRole("status")
      expect(status).toHaveAttribute("aria-live", "polite")
      expect(status).toHaveTextContent(`Reading ${pane} settings`)
      expect(status).toHaveTextContent(/^Reading \w+ settings$/)
    }
  )
})
