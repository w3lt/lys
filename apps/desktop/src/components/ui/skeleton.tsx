import { cn } from "@/lib/utils"

/**
 * Renders a non-semantic loading placeholder over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="skeleton"`; the caller
 * supplies the silhouette through `className`. The sweep honors
 * `--skeleton-delay` inherited from a group and disables animation under
 * `prefers-reduced-motion`; a supplied `ref` targets the native
 * `HTMLDivElement`. The adapter owns no state, portal, focus, or failure
 * handling.
 * @param props - Native placeholder props, children, and optional styling.
 * @returns The styled loading placeholder.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-[lys-skeleton-sweep_1.4s_linear_infinite] rounded-[var(--radius-detail)] bg-[image:var(--gradient-skeleton)] bg-[length:240%_100%] [animation-delay:var(--skeleton-delay,0ms)] data-[tone=muted]:bg-[image:var(--gradient-skeleton-muted)] motion-reduce:animate-none motion-reduce:bg-[position:50%_0]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
