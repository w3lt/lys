import { SCENARIOS } from "@/app/scenarios"
import type { ScenarioKey } from "@/app/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import "./TitleBar.css"

interface TitleBarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onScenarioSelect: (key: ScenarioKey) => void
}

export function TitleBar({
  open,
  onOpenChange,
  onScenarioSelect,
}: TitleBarProps) {
  return (
    <header className="title-bar" data-tauri-drag-region>
      <div aria-hidden="true" className="title-bar__native-controls" />
      <div className="title-bar__title" data-tauri-drag-region>
        <span className="title-bar__name">Lys</span>
        <span className="title-bar__version">v1</span>
      </div>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        triggerId="reference-states"
      >
        <DropdownMenuTrigger
          className="title-bar__scenario-trigger"
          id="reference-states"
          render={<Button size="lysCompact" variant="lysOutline" />}
        >
          Reference states
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="title-bar__scenario-menu"
        >
          {SCENARIOS.map((scenario) => (
            <DropdownMenuItem
              key={scenario.key}
              className="title-bar__scenario-item"
              onClick={() => onScenarioSelect(scenario.key)}
            >
              <span>{scenario.label}</span>
              <span aria-hidden="true">{scenario.number}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
