import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Renders a styled native `select` in the frame of an `Input`.
 *
 * @remarks Native `select` props,
 * option children, value state, and event handlers are forwarded unchanged;
 * native focus, keyboard, option list, disabled, and validation semantics
 * remain with the host, so the platform draws the open list. A supplied `ref`
 * targets the native `HTMLSelectElement`; the adapter adds
 * `data-slot="native-select"` and owns no state, portal, or failure handling.
 * @param props - Native select props, options, and optional styling.
 * @returns The styled native select host.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--app-border-strong)] bg-[var(--app-surface-field)] px-2.5 text-control text-[var(--app-text)] outline-none transition-[color,background-color,border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
