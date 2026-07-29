import { useCallback, useEffect, useState } from "react"

export type Theme = "dark" | "light"

const STORAGE_KEY = "lys.theme"

/*
 * Dark is the canonical Lys appearance, so it is also the fallback whenever
 * nothing has been stored yet or storage is unavailable. index.html ships the
 * `dark` class so the first paint already matches this default.
 */
const DEFAULT_THEME: Theme = "dark"

function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)

    return stored === "light" || stored === "dark" ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

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

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"))
  }, [])

  return { theme, toggleTheme }
}
