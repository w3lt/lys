import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merges conditional class values and resolves conflicting Tailwind utilities.
 *
 * @param inputs - Class values accepted by `clsx`, in precedence order.
 * @returns A normalized class string, or an empty string when no values are active.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
