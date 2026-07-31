import { cn } from "@/lib/utils"

/*
 * A single sheen of the brand violet sweeps across each bar instead of the
 * generic opacity pulse. Set --skeleton-delay on a group's container to
 * stagger its bars; the property inherits, so it is declared once per group.
 * Silhouette stays with the caller, whose classes take precedence below.
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
