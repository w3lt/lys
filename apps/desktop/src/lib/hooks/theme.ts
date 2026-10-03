import type { LysPersonalityPeriod } from "@lys/share"
import { useCallback, useLayoutEffect } from "react"

import { calculateTheme, type Theme } from "@/app/theme"
import { useLysStore } from "../store"

/** Theme shown by the application and the action that switches it. */
export type ThemeControl = {
  /** Theme currently applied to the document. */
  readonly theme: Theme
  /** Selects the opposite theme for the rest of the current period. */
  readonly toggleTheme: () => void
}

/**
 * Provides the application theme for a period of Lys's personality and
 * applies it to the document.
 *
 * @param lysPersonalityPeriod - Current period, reactive: when a new period
 * begins, the theme becomes the new side's theme unless the person selects
 * another one during that period.
 * @returns The applied theme and a toggle. The toggle records the opposite
 * theme as the person's choice for the period the caller rendered with,
 * through the application store, which saves it for later sessions when
 * storage allows.
 * @remarks Reads the theme choice from the application store, so the caller
 * must be allowed to read application state. While the caller is mounted,
 * the `dark` class on the document root follows the theme; the class is left
 * in place on unmount. `index.html` ships the class, so the page is dark until
 * the caller first renders. The class is set in the layout phase, before the
 * browser paints, so the caller's first frame already shows the derived theme
 * instead of flashing the shipped dark theme during the light side.
 */
export function useTheme(
  lysPersonalityPeriod: LysPersonalityPeriod
): ThemeControl {
  const themeChoice = useLysStore((state) => state.themeChoice)
  const updateThemeChoice = useLysStore((state) => state.updateThemeChoice)
  const theme = calculateTheme(themeChoice, lysPersonalityPeriod)

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  /** Records the opposite of the shown theme as the current period's choice. */
  const toggleTheme = useCallback(() => {
    updateThemeChoice({
      theme: theme === "dark" ? "light" : "dark",
      personalityPeriod: lysPersonalityPeriod
    })
  }, [theme, lysPersonalityPeriod, updateThemeChoice])

  return { theme, toggleTheme }
}
