import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

/**
 * Renders a horizontal or vertical separator over the Base UI separator host.
 *
 * @remarks Primary category: UI primitive adapter. Base UI separator props are
 * forwarded; `orientation` defaults to `horizontal` and controls the host's
 * orientation and corresponding dimensions. Base UI supplies separator
 * semantics. A supplied `ref` targets the Base UI `HTMLDivElement` host; the
 * adapter owns no state, portal, keyboard behavior, or failure handling.
 * @param props - Base UI separator props and optional orientation.
 * @returns The styled separator host.
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
