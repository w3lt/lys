import { useCallback, useEffect, useState } from "react"

/** Supported document appearance modes. */
export type Theme = "dark" | "light"

/** Local-storage key used for the user's appearance preference. */
const STORAGE_KEY = "lys.theme"

/*
 * Dark is the canonical Lys appearance, so it is also the fallback whenever
 * nothing has been stored yet or storage is unavailable. index.html ships the
 * `dark` class so the first paint already matches this default.
 */
/** Appearance used when storage is absent, invalid, or unavailable. */
const DEFAULT_THEME: Theme = "dark"

/**
 * Reads and validates the persisted theme without allowing storage errors to escape.
 *
 * @returns The stored supported theme, or the dark default when absent, invalid, or unavailable.
 */
function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)

    return stored === "light" || stored === "dark" ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * Provides the current theme and a toggle that updates the document and local storage.
 *
 * @returns The current theme and a synchronous toggle callback. Storage failures are
 * ignored so the document appearance still changes.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")

    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Denied storage must not stop the appearance from changing.
    }
  }, [theme])

  /** Toggles the component-owned theme state between the two supported modes. */
  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"))
  }, [])

  return { theme, toggleTheme }
}
