import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * Names the steps of the type scale that `index.css` declares as its only
 * `--text-*` theme values, smallest first.
 *
 * @remarks The merger must know them as font sizes: it otherwise reads
 * `text-control` as a text color and drops it when a later class sets one.
 * A step added to or removed from `index.css` changes this list too.
 */
const TYPE_SCALE_STEPS = [
  "tag",
  "meta",
  "note",
  "body",
  "control",
  "lead",
  "title",
  "heading",
  "display"
]

/** Resolves conflicting Tailwind utilities against the app's own type scale. */
const mergeTailwindClasses = extendTailwindMerge({
  override: { theme: { text: TYPE_SCALE_STEPS } }
})

/**
 * Merges conditional class values and resolves conflicting Tailwind utilities.
 *
 * @param inputs - Class values accepted by `clsx`, in precedence order.
 * @returns A normalized class string, or an empty string when no values are active.
 */
export function cn(...inputs: ClassValue[]) {
  return mergeTailwindClasses(clsx(inputs))
}
