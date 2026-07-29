import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        /*
         * The capsule track is an explicit functional exception to the
         * soft-square geometry; thumb travel carries the state without color.
         */
        "peer group/switch relative inline-flex shrink-0 items-center rounded-[var(--radius-capsule)] border border-[var(--app-border-strong)] outline-none transition-[background-color,border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-[var(--app-action)] data-checked:bg-[var(--app-control-selected)] data-unchecked:bg-[var(--app-control-track)] data-disabled:cursor-not-allowed data-disabled:opacity-70",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-[var(--radius-capsule)] bg-[var(--app-control-thumb)] ring-0 transition-transform duration-(--duration-standard) ease-(--ease-standard) group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-checked/switch:bg-[var(--app-control-selected-thumb)] group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
