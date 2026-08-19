import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Supplies the alert surface variants used by {@link Alert}.
 *
 * @remarks Primary category: UI primitive adapter. The default variant uses
 * the card foreground, while `destructive` uses the destructive foreground
 * for the alert and its description and icon
 * content. The default is `default`; callers may extend the returned class
 * list through the component's native `className` prop.
 */
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-[var(--radius-surface)] border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
)

/**
 * Renders an alert container with Lys surface variants over a native `div`.
 *
 * @remarks Primary category: UI primitive adapter. Native `div` props and
 * children are forwarded, and the optional `variant` selects the maintained
 * `default` or `destructive` styling with `default` as the fallback. The host
 * is marked with `data-slot="alert"` and `role="alert"`. A supplied `ref`
 * targets the native `HTMLDivElement`; this adapter owns no state, portal,
 * callbacks, or failure handling.
 * @param props - Native alert container props, children, and optional variant.
 * @returns The alert host with its forwarded content and semantic alert role.
 */
function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * Renders the title region of an {@link Alert} over a native `div`.
 *
 * @remarks Primary category: UI primitive adapter. Native `div` props and
 * children are forwarded and marked with `data-slot="alert-title"`; the
 * parent alert supplies the surrounding role and announcement semantics. The
 * A supplied `ref` targets the native `HTMLDivElement`; the adapter owns no
 * state, effects, or failure handling.
 * @param props - Native title-region props and children.
 * @returns The styled alert title region.
 */
function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders the descriptive content region of an {@link Alert} over a native
 * `div`.
 *
 * @remarks Primary category: UI primitive adapter. Native `div` props and
 * children are forwarded and marked with `data-slot="alert-description"`;
 * the parent alert supplies the surrounding role and announcement semantics.
 * A supplied `ref` targets the native `HTMLDivElement`; the adapter owns no
 * state, effects, or failure handling.
 * @param props - Native description-region props and children.
 * @returns The styled alert description region.
 */
function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

/**
 * Positions an action region inside an {@link Alert} over a native `div`.
 *
 * @remarks Primary category: UI primitive adapter. Native `div` props and
 * children are forwarded and marked with `data-slot="alert-action"`; the
 * parent alert's styling reserves space for this region. A supplied `ref`
 * targets the native `HTMLDivElement`; the adapter owns no state, effects, or
 * failure handling.
 * @param props - Native action-region props and children.
 * @returns The positioned alert action region.
 */
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
