import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        lysPrimary:
          "rounded-none border-[var(--lys-accent)] bg-[var(--lys-accent)] font-mono text-[10px] uppercase tracking-[0.18em] text-[#12100c] hover:bg-[#f0d6a6]",
        lysOutline:
          "rounded-none border-[#2c2c34] bg-transparent font-mono text-[10px] uppercase tracking-[0.16em] text-[#c9c4b8] hover:border-[#3e3e48] hover:bg-[#16161b] hover:text-[#f0ebe0]",
        lysGhost:
          "rounded-none border-transparent bg-transparent font-mono text-[10px] uppercase tracking-[0.16em] text-[#6e6c66] hover:bg-transparent hover:text-[#e8e4dc]",
        lysDanger:
          "rounded-none border-[#3e2c28] bg-transparent font-mono text-[10px] uppercase tracking-[0.16em] text-[#c97a6a] hover:bg-[#241715] hover:text-[#efc0af]",
        lysMeta:
          "h-auto rounded-none border-transparent bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.18em] text-[#5a5852] hover:bg-transparent hover:text-[#c9c4b8]",
        lysNav:
          "h-auto w-full justify-between rounded-none border-l-2 border-transparent bg-transparent px-[18px] py-[11px] font-mono text-[11.5px] font-normal text-[#7c7973] hover:bg-[#101016] hover:text-[#f0ebe0] data-[state=active]:border-[var(--lys-accent)] data-[state=active]:bg-[#101016] data-[state=active]:text-[#f0ebe0]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lysCompact: "h-auto gap-2 rounded-none px-3 py-[7px]",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef<
  React.ComponentRef<typeof ButtonPrimitive>,
  ButtonPrimitive.Props & VariantProps<typeof buttonVariants>
>(function Button({ className, variant = "default", size = "default", ...props }, ref) {
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
