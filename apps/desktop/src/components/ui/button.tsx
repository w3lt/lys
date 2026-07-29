import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
 * Lys styling is the default appearance of this primitive, so variants name a
 * purpose rather than a theme. Sizes follow the one compact desktop density:
 * 28 / 32 / 36px, with 14 / 16 / 18px icons.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow,filter,translate] duration-(--duration-standard) ease-(--ease-standard) select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-lys-primary text-[var(--app-action-foreground)] shadow-lys-glow hover:brightness-[1.08] hover:saturate-[1.06] active:brightness-[0.98]",
        outline:
          "border-[var(--app-border-strong)] bg-transparent text-[var(--app-text)] hover:border-[var(--app-border-interactive)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)] aria-expanded:bg-[var(--app-surface-hover)] aria-expanded:text-[var(--app-text-strong)] aria-pressed:border-[var(--app-border-interactive)] aria-pressed:bg-[var(--app-surface-selected)] aria-pressed:text-[var(--app-text-strong)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "bg-transparent text-[var(--app-text-muted)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)] aria-expanded:bg-[var(--app-surface-hover)] aria-expanded:text-[var(--app-text-strong)]",
        destructive:
          "border-[var(--app-border-danger)] bg-destructive/10 text-[var(--app-text-danger)] hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-[var(--app-text-link)] underline-offset-4 hover:underline"
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        sm: "h-7 gap-1 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-[18px]",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-[18px]"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
)

const Button = React.forwardRef<
  React.ComponentRef<typeof ButtonPrimitive>,
  ButtonPrimitive.Props & VariantProps<typeof buttonVariants>
>(function Button(
  { className, variant = "default", size = "default", ...props },
  ref
) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
