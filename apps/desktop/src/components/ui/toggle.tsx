import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleVariants = cva(
  /*
   * Selection reads without hover through a surface change and a heavier
   * weight — the weight keeps it legible without relying on color.
   */
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

export { Toggle, toggleVariants }
