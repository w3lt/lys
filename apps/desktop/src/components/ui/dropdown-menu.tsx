import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

/**
 * Provides the root context for a composed dropdown menu.
 *
 * @remarks Base UI menu root props and
 * children are forwarded. A controlled `open` value is parent-owned, while
 * `defaultOpen` gives Base UI ownership of the uncontrolled initial state; Base
 * UI coordinates item registration, focus, keyboard navigation, and state
 * attributes. The root renders no DOM host; its `actionsRef` targets Base UI
 * imperative menu actions. Use its trigger, content, and item parts.
 * @param props - Base UI menu root props and menu children.
 * @returns The Base UI menu root context provider.
 */
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

/**
 * Renders the control that opens a {@link DropdownMenu}.
 *
 * @remarks Base UI trigger props,
 * children, and callbacks are forwarded; a controlled `open` value is
 * parent-owned and `defaultOpen` is primitive-owned. Base UI coordinates focus
 * return and keyboard activation. A supplied `ref` targets the trigger's
 * `HTMLElement` host; no portal, placement, or failure behavior is added here.
 * @param props - Base UI menu trigger props and trigger content.
 * @returns The Base UI menu trigger.
 */
function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

/**
 * Renders positioned dropdown content with a Base UI portal and positioner.
 *
 * @remarks Base UI popup props and
 * children are forwarded; `align`, `alignOffset`, `side`, and `sideOffset`
 * control placement and default to `start`, `0`, `bottom`, and `4`. The wrapper
 * owns the portal/positioner composition while Base UI owns collision
 * handling, focus management, keyboard navigation, open/closed state, and
 * `data-side`/`data-open`/`data-closed` attributes. A menu root is required by
 * the underlying primitive and its missing context error propagates. A
 * supplied `ref` targets the popup's `HTMLDivElement` host.
 * @param props - Popup props, children, and positioner placement options.
 * @returns Portaled and positioned dropdown popup content.
 */
function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-[var(--radius-surface)] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/**
 * Groups related items in a {@link DropdownMenu} over the Base UI group part.
 *
 * @remarks Base UI group props and
 * children are forwarded through the group's own context; labels require this
 * group or a radio-group context. Item focus and keyboard behavior remain
 * owned by Base UI. A supplied `ref` targets the group's `HTMLDivElement`
 * host; this adapter owns no state, portal, placement, or failure handling.
 * @param props - Base UI menu group props and item children.
 * @returns The grouped menu items.
 */
function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

/**
 * Renders a non-interactive label for a {@link DropdownMenuGroup}.
 *
 * @remarks Base UI group-label props
 * and children are forwarded; `inset` adds the repository's item alignment and
 * is exposed as `data-inset`. A `Menu.Group` or `Menu.RadioGroup` context is
 * required; Base UI's missing-context error propagates otherwise. The
 * surrounding menu supplies keyboard behavior. A supplied `ref` targets the
 * label's `HTMLDivElement` host; this wrapper owns no state, portal, or failure
 * handling of its own.
 * @param props - Base UI group-label props, children, and optional inset flag.
 * @returns The styled menu group label.
 */
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  /** Whether the label aligns with an inset menu item. */
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-note font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders an actionable item in a {@link DropdownMenu}.
 *
 * @remarks Base UI item props,
 * children, and callbacks are forwarded. `variant` is a repository styling
 * choice (`default` or `destructive`, defaulting to `default`) and `inset`
 * controls alignment; both are exposed as data attributes. Base UI owns item
 * focus, keyboard activation, disabled state, and menu context; a menu root is
 * required and missing context fails through the primitive. A supplied `ref`
 * targets the item's `HTMLElement` host.
 * @param props - Base UI item props, children, callbacks, and style options.
 * @returns The styled actionable menu item.
 */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  /** Whether the item aligns its content with inset menu rows. */
  inset?: boolean
  /** Styling variant for the item surface and focus state. */
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 py-1 text-control outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

/**
 * Provides radio-group context for mutually exclusive menu items.
 *
 * @remarks Base UI radio-group props
 * and children are forwarded; a controlled `value` is parent-owned, while
 * `defaultValue` is primitive-owned. Base UI coordinates keyboard behavior and
 * item registration. This group creates the context required by its radio
 * items; a supplied `ref` targets the group's `HTMLDivElement` host.
 * @param props - Base UI radio-group props and radio-item children.
 * @returns The Base UI radio-group context provider.
 */
function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

/**
 * Renders a mutually exclusive radio item in a menu radio group.
 *
 * @remarks Base UI radio-item props,
 * children, and callbacks are forwarded; `inset` controls alignment and is
 * exposed as `data-inset`. The wrapper supplies a check indicator, while a
 * parent-controlled radio-group value or the primitive's `defaultValue` owns
 * selection; Base UI coordinates registration, focus, and keyboard behavior.
 * A menu root and radio-group context are required; missing context fails
 * through Base UI. A supplied `ref` targets the item's `HTMLElement` host.
 * @param props - Base UI radio-item props, children, callbacks, and inset flag.
 * @returns The styled radio menu item with its indicator.
 */
function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  /** Whether the radio item aligns with inset menu rows. */
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] py-1 pr-8 pl-1.5 text-control outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

/**
 * Renders a visual separator between dropdown menu regions.
 *
 * @remarks Base UI separator props
 * are forwarded and the host is marked with `data-slot="dropdown-menu-separator"`.
 * A supplied `ref` targets the Base UI `HTMLDivElement` host. It owns no state,
 * portal, placement, keyboard behavior, or failure handling; semantic grouping
 * remains with the menu composition.
 * @param props - Base UI separator props.
 * @returns The styled menu separator.
 */
function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
}
