import type { StoreApi } from "zustand"
import { saveThemeChoice, type ThemeChoice } from "@/app/theme"

/** Theme choice state and its update, composed into the application store. */
export type ThemeSlice = {
  /**
   * Latest theme choice the person made.
   *
   * @remarks Absent until application initialization reads the stored
   * choice, and afterwards when no usable choice was stored and the person
   * has not selected a theme yet.
   */
  readonly themeChoice: ThemeChoice | undefined
  /**
   * Applies a theme choice and saves it for later sessions.
   *
   * @param themeChoice - Choice made with the title-bar toggle.
   * @remarks The choice applies even when storage refuses it; it then lasts
   * only for the current session.
   */
  updateThemeChoice: (themeChoice: ThemeChoice) => void
}

/**
 * Registers theme choice state and its update with one Zustand owner.
 *
 * @param set - Framework setter for atomic theme choice updates.
 * @returns The initially absent choice and its update action.
 */
export function createThemeSlice(
  set: StoreApi<ThemeSlice>["setState"]
): ThemeSlice {
  /** Implements {@link ThemeSlice.updateThemeChoice}. */
  function updateThemeChoice(themeChoice: ThemeChoice): void {
    set({ themeChoice })
    try {
      saveThemeChoice(themeChoice)
    } catch {
      // Persisting this preference is optional: a refused write keeps the
      // applied choice for the current session only.
    }
  }

  return { themeChoice: undefined, updateThemeChoice }
}
