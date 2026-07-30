import { Moon, Sun } from "lucide-react"

import { useTheme } from "@/app/theme"
import { Button } from "@/components/ui/button"

import "./TitleBar.scss"

export function TitleBar() {
  const { theme, toggleTheme } = useTheme()
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <header className="title-bar" data-tauri-drag-region>
      <div aria-hidden="true" className="title-bar__native-controls" />
      <div className="title-bar__title" data-tauri-drag-region>
        <span className="title-bar__name">Lys</span>
        <span className="title-bar__version">v1</span>
      </div>
      <div className="title-bar__actions">
        <Button
          aria-label={`Switch to ${nextTheme} theme`}
          onClick={toggleTheme}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {theme === "dark" ? (
            <Sun aria-hidden="true" />
          ) : (
            <Moon aria-hidden="true" />
          )}
        </Button>
      </div>
    </header>
  )
}
