import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Supplies the maintained variants used by {@link Toggle} and toggle-group
 * items.
 *
 * @remarks `variant` supports
 * `default` and `outline`; `size` supports `default`, `sm`, and `lg`. Both
 * default to `default`. Selected state is represented through the primitive's
 * `aria-pressed` attribute and styling, while this utility only supplies class
 * combinations.
 */
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-[var(--radius-control)] border border-transparent text-sm font-medium whitespace-nowrap text-[var(--app-text-muted)] outline-none transition-[color,background-color,border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:border-[var(--app-border-interactive)] aria-pressed:bg-[var(--app-surface-selected)] aria-pressed:font-semibold aria-pressed:text-[var(--app-text-strong)] dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border-[var(--app-border-default)] bg-[var(--app-surface-content)]"
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-[18px]"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
)

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
