import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import type { VariantProps } from "class-variance-authority"

import { toggleVariants } from "@/components/ui/toggle-variants"
import { cn } from "@/lib/utils"

/**
 * Renders a Base UI toggle with Lys variants.
 *
 * @remarks Base UI toggle props,
 * children, controlled or uncontrolled pressed state, and callbacks are
 * forwarded. A controlled `pressed` value is parent-owned, while
 * `defaultPressed` is primitive-owned after initialization. `variant` and
 * `size` default to `default`; Base UI coordinates focus, keyboard
 * activation, disabled behavior, and `aria-pressed` state. A supplied `ref`
 * targets the Base UI toggle's `HTMLButtonElement` host; the adapter owns no
 * portal or failure handling.
 * @param props - Base UI toggle props, children, callbacks, and style variants.
 * @returns The styled toggle control.
 */
function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle }
