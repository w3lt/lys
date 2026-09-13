import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"
import { ChevronRightIcon, CheckIcon } from "lucide-react"

/**
 * Provides the root context for a composed dropdown menu.
 *
 * @remarks Base UI menu root props and
 * children are forwarded. A controlled `open` value is parent-owned, while
 * `defaultOpen` gives Base UI ownership of the uncontrolled initial state; Base
 * UI coordinates item registration, focus, keyboard navigation, and state
 * attributes. The root renders no DOM host; its `actionsRef` targets Base UI
 * imperative menu actions. Use its portal, trigger, content, and item parts.
 * @param props - Base UI menu root props and menu children.
 * @returns The Base UI menu root context provider.
 */
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

/**
 * Portals dropdown content using the Base UI menu portal contract.
 *
 * @remarks Base UI portal props and
 * children are forwarded; a {@link DropdownMenu} root is required and its
 * missing-context error propagates from Base UI. Placement and lifecycle of
 * the portal remain owned by Base UI. A supplied `ref` targets the portal's
 * `HTMLDivElement` host. This part owns no menu state, callbacks, or failure
 * handling.
 * @param props - Base UI portal props and dropdown content.
 * @returns The portal host for menu content.
 */
function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
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
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
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
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

/**
 * Provides the root context for a nested submenu in a {@link DropdownMenu}.
 *
 * @remarks Base UI submenu-root props
 * and children are forwarded; submenu open state, focus transfer, and keyboard
 * navigation remain owned by Base UI. Controlled `open` is parent-owned while
 * `defaultOpen` is primitive-owned. The root renders no DOM host; its
 * `actionsRef` targets Base UI imperative submenu actions. Pair it with its
 * trigger and content parts.
 * @param props - Base UI submenu root props and nested menu children.
 * @returns The Base UI submenu root context provider.
 */
function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

/**
 * Renders the trigger for a nested submenu.
 *
 * @remarks Base UI submenu-trigger
 * props, callbacks, and caller children are forwarded; the wrapper appends a
 * chevron indicator and exposes `inset` as `data-inset`. Base UI owns focus,
 * keyboard navigation, open state, and submenu context; a submenu root is
 * required and missing context fails through the primitive. A supplied `ref`
 * targets the trigger's `HTMLElement` host.
 * @param props - Base UI submenu-trigger props, children, and inset flag.
 * @returns The styled submenu trigger with its chevron indicator.
 */
function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  /** Whether the trigger aligns with inset menu rows. */
  inset?: boolean
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

/**
 * Renders positioned content for a nested dropdown submenu.
 *
 * @remarks This delegates to
 * {@link DropdownMenuContent} with submenu defaults of `align="start"`,
 * `alignOffset=-3`, `side="right"`, and `sideOffset=0`; popup props and
 * children are forwarded. Its composed Portal, Positioner, and Popup require
 * the menu-root context; missing menu-root context errors propagate from Base
 * UI. The Positioner owns collision placement; the Popup/menu-root focus
 * manager composition owns focus management and keyboard behavior. A supplied
 * `ref` targets the popup's `HTMLDivElement` host.
 * @param props - Submenu popup props, children, and placement overrides.
 * @returns Portaled and positioned submenu popup content.
 */
function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "w-auto min-w-[96px] rounded-[var(--radius-surface)] bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

/**
 * Renders a checkable item in a {@link DropdownMenu}.
 *
 * @remarks Base UI checkbox-item props,
 * `checked` state, children, and callbacks are forwarded; `inset` controls
 * alignment and is exposed as `data-inset`. The wrapper supplies a check
 * indicator. A controlled `checked` value is parent-owned, while
 * `defaultChecked` is primitive-owned; Base UI coordinates menu context,
 * focus, keyboard behavior, and disabled state. A menu root is required and
 * missing context fails through the primitive. A supplied `ref` targets the
 * item's `HTMLElement` host.
 * @param props - Base UI checkbox-item props, checked state, children, and
 * alignment option.
 * @returns The styled checkable menu item with its indicator.
 */
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  /** Whether the checkbox item aligns with inset menu rows. */
  inset?: boolean
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
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
        "relative flex cursor-default items-center gap-1.5 rounded-[var(--radius-control)] py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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

/**
 * Renders shortcut text aligned to the trailing edge of a menu item.
 *
 * @remarks Native `span` props and
 * children are forwarded and marked with `data-slot="dropdown-menu-shortcut"`.
 * A supplied `ref` targets the native `HTMLSpanElement`; the content is
 * descriptive only and does not register a keyboard shortcut, own focus, or
 * participate in menu state, portals, or failures.
 * @param props - Native shortcut-label props and children.
 * @returns The styled shortcut label.
 */
function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
}
