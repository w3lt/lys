import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Provides the root context for a composed tab set.
 *
 * @remarks Primary category: UI primitive adapter. Base UI tab-root props and
 * children are forwarded; `orientation` defaults to `horizontal` and is
 * mirrored in `data-orientation` for repository layout styling. A controlled
 * `value` is parent-owned, while `defaultValue` is primitive-owned after
 * initialization; Base UI coordinates tab/panel relationships, focus,
 * keyboard navigation, and state attributes. A supplied `ref` targets the
 * root's `HTMLDivElement` host; this adapter owns no portal, callbacks, or
 * failure handling.
 * @param props - Base UI tab-root props, children, and optional orientation.
 * @returns The tab root context provider.
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

/**
 * Supplies the maintained list variants used by {@link TabsList}.
 *
 * @remarks Primary category: UI primitive adapter. `default` uses a muted
 * surface and `line` uses a transparent list with a gap; `default` is the
 * fallback. Selected-value authority remains the tabs root's
 * controlled/uncontrolled contract, while Base UI coordinates tab interaction
 * and keyboard behavior.
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-[var(--radius-surface)] p-[3px] text-[var(--app-text-muted)] group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
)

/**
 * Renders the list container for a {@link Tabs} family.
 *
 * @remarks Primary category: UI primitive adapter. Base UI list props and tab
 * trigger children are forwarded. `variant` selects `default` or `line`
 * styling and defaults to `default`; it is exposed as `data-variant`. A
 * {@link Tabs} root is required and its missing-context error propagates from
 * Base UI. The surrounding root owns tab registration, while the parent or
 * primitive owns selected value as described by the root. A supplied `ref`
 * targets the list's `HTMLDivElement` host; this adapter owns no portal or
 * failure handling.
 * @param props - Base UI list props, tab triggers, and optional variant.
 * @returns The styled tab list.
 */
function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * Renders one selectable tab trigger in a {@link TabsList}.
 *
 * @remarks Primary category: UI primitive adapter. Base UI tab props, children,
 * value, and callbacks are forwarded; the parent or primitive owns selected
 * state through the root's controlled/uncontrolled value contract. Base UI
 * coordinates tab/panel association, focus, keyboard navigation, disabled
 * behavior, and active state attributes. A {@link Tabs} root and
 * {@link TabsList} are required; missing context errors propagate from Base UI.
 * A supplied `ref` targets the trigger's `HTMLElement` host; this adapter owns
 * no portal or failure handling.
 * @param props - Base UI tab props, value, children, and callbacks.
 * @returns The styled tab trigger.
 */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        /*
         * The active trigger reads through a surface change and a heavier
         * weight; the weight keeps the state legible without relying on color.
         * It carries no edge marker — a bar or trace on a navigation rail
         * competes with the active surface for the same boundary.
         *
         * Filling the list is horizontal-only. In a vertical rail the trigger
         * is a 32px control stacked with its siblings; growing to the list
         * height there would let the first trigger swallow the whole rail.
         */
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-[var(--app-text-muted)] outline-none transition-[color,background-color,border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) group-data-horizontal/tabs:h-[calc(100%-1px)] group-data-horizontal/tabs:flex-1 group-data-vertical/tabs:h-8 group-data-vertical/tabs:w-full group-data-vertical/tabs:flex-none group-data-vertical/tabs:justify-start hover:text-[var(--app-text-strong)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-70 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-70 data-active:bg-[var(--app-surface-navigation-active)] data-active:font-semibold data-active:text-[var(--app-text-strong)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders one panel associated with a {@link TabsTrigger}.
 *
 * @remarks Primary category: UI primitive adapter. Base UI panel props,
 * children, and `value` are forwarded; a {@link Tabs} root is required and its
 * missing-context error propagates from Base UI. The parent or primitive owns
 * selected value through the root's controlled/uncontrolled contract, while
 * Base UI coordinates the value relationship, visibility, focus behavior, and
 * associated state attributes. A supplied `ref` targets the panel's
 * `HTMLDivElement` host; this adapter owns no portal, callbacks, or failure
 * handling.
 * @param props - Base UI panel props, value, and panel children.
 * @returns The styled tab panel.
 */
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
