"use client"

import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

/**
 * Carries toggle-group styling and layout values to descendant items.
 *
 * @remarks The context is local to
 * this adapter family. Its defaults are `variant="default"`, `size="default"`,
 * `spacing=2`, and `orientation="horizontal"`; {@link ToggleGroup} replaces
 * them for its descendants. It does not own selected-value state or
 * application state.
 */
const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    /** Gap between adjacent toggle items in CSS spacing units. */
    spacing?: number
    /** Layout direction applied to the group and its item selectors. */
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal"
})

/**
 * Renders a Base UI toggle group and provides its shared styling context.
 *
 * @remarks Base UI group props,
 * children, selected-value state, and callbacks are forwarded. `orientation`
 * defaults to `horizontal`, `spacing` defaults to `2`, and `variant`/`size`
 * are passed to descendant items through a local context; the values are also
 * exposed as data attributes. A controlled group `value` is parent-owned,
 * while `defaultValue` is primitive-owned after initialization. Base UI
 * coordinates group keyboard/focus behavior and value semantics. A supplied
 * `ref` targets the root's `HTMLDivElement` host; this adapter owns only layout
 * context and no portal or failure handling.
 * @param props - Base UI group props, children, orientation, spacing, and
 * optional shared toggle variants.
 * @returns The styled toggle-group root and its context provider.
 */
function ToggleGroup({
  className,
  variant,
  size,
  spacing = 2,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    /** Gap between adjacent toggle items in CSS spacing units. */
    spacing?: number
    /** Layout direction forwarded to the Base UI group. */
    orientation?: "horizontal" | "vertical"
  }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-[var(--radius-control)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

/**
 * Renders one selectable item in a {@link ToggleGroup}.
 *
 * @remarks Base UI toggle props,
 * children, controlled or uncontrolled pressed state, and callbacks are
 * forwarded. Item `variant` and `size` default to `default` but are overridden
 * by the nearest group's context when supplied; spacing and orientation are
 * likewise inherited through the ancestor group's selectors; the item exposes
 * `data-spacing` but does not render its own `data-orientation`. Inside a
 * {@link ToggleGroup}, pressed state is derived from the parent's controlled
 * group `value` or the primitive-owned group `defaultValue`; item
 * `pressed`/`defaultPressed` do not independently own selection there. Outside
 * a group, the item uses its own local controlled or uncontrolled pressed
 * contract. Base UI coordinates focus, keyboard activation, disabled behavior,
 * and `aria-pressed` state, while the surrounding group owns item registration
 * and value semantics. A supplied `ref` targets the item's `HTMLElement` host.
 * @param props - Base UI toggle-item props, children, callbacks, and fallback
 * style variants.
 * @returns The styled toggle-group item.
 */
function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        /*
         * A joined group (spacing 0) squares its internal seams but keeps the
         * group's outer silhouette symmetrical at the control radius.
         */
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-[var(--radius-control)] group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-[var(--radius-control)] group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-[var(--radius-control)] group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-[var(--radius-control)] group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size
        }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
