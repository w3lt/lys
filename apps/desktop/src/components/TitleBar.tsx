import type { LysPersonalityPeriod } from "@lys/share"
import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useTheme } from "@/lib/hooks/theme"

import "./TitleBar.scss"

/** Properties accepted by {@link TitleBar}. */
type TitleBarProps = {
  /**
   * Current period of Lys's personality, owned by the parent. A new period
   * switches the theme to its side's theme.
   */
  readonly lysPersonalityPeriod: LysPersonalityPeriod
}

/**
 * Presents the draggable application title bar and theme toggle.
 *
 * @remarks The theme hook derives the
 * theme from the application store's theme choice and the parent's period,
 * and owns the toggle capability; this component owns no duplicate theme
 * state or resource. The toggle changes the appearance only, never Lys's
 * side, and its choice lasts until a new period begins. The native drag
 * region remains non-interactive, while the button exposes the next theme in
 * its accessible label and invokes the theme hook transition once per click.
 * @param props - Parent-owned current period of Lys's personality.
 * @returns The title bar with application identity and theme control.
 */
export function TitleBar({ lysPersonalityPeriod }: TitleBarProps) {
  const { theme, toggleTheme } = useTheme(lysPersonalityPeriod)
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <header className="title-bar" data-tauri-drag-region>
      <div aria-hidden="true" className="title-bar__native-controls" />
      <div className="title-bar__title" data-tauri-drag-region>
        <span className="title-bar__name">Lys</span>
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
