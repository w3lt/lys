import type { ReactElement, ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

/** Properties accepted by {@link Tooltip}. */
type TooltipProps = {
  /** Plain text shown while the pointer rests on the trigger content. */
  readonly description: string
  /** Trigger content; its own controls keep their native behavior. */
  readonly children: ReactNode
}

/**
 * Shows a short plain-text description while the pointer rests on its trigger content.
 *
 * @remarks The trigger is a non-focusable inline wrapper, so it also works
 * around a disabled control, which receives no pointer events. The adapter
 * adds no focus stop: keyboard and assistive-technology users must receive the
 * same text from the surrounding view, for example through `aria-describedby`.
 * The description opens after 600 ms of hover, closes immediately when the
 * pointer leaves or the trigger is clicked, stays open while the pointer is
 * over it, and appears above the trigger, centered, 6 px away. Base UI owns
 * open state, positioning, and Escape dismissal. No Base UI type or prop
 * leaves this adapter.
 * @param props - Description text and trigger content.
 * @returns The trigger with its portaled description popup.
 */
function Tooltip({ description, children }: TooltipProps): ReactElement {
  return (
    <TooltipPrimitive.Root disableHoverablePopup={false}>
      <TooltipPrimitive.Trigger
        closeDelay={0}
        closeOnClick
        delay={600}
        render={<span className="inline-flex" />}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align="center"
          className="isolate z-50"
          side="top"
          sideOffset={6}
        >
          <TooltipPrimitive.Popup
            data-slot="tooltip-content"
            className="max-w-64 rounded-[var(--radius-control)] bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            {description}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip }
