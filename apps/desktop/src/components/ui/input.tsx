import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * Renders a styled Base UI text input over the native `input` host.
 *
 * @remarks Primary category: UI primitive adapter. Native input props,
 * `type`, value state, and event handlers are forwarded to Base UI, which
 * preserves native focus, keyboard, disabled, read-only, and validation
 * semantics. A supplied `ref` targets the Base UI input's `HTMLElement` host.
 * The adapter adds `data-slot="input"` and owns no state, portal, or failure
 * handling.
 * @param props - Native input props and optional input type.
 * @returns The styled Base UI input host.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--app-border-strong)] bg-[var(--app-surface-field)] px-2.5 py-1 text-sm text-[var(--app-text)] outline-none transition-[color,background-color,border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--app-text-faint)] read-only:bg-[var(--app-surface-code)] read-only:text-[var(--app-text-muted)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
