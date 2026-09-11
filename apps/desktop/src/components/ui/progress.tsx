import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { cn } from "@/lib/utils"

/**
 * Renders a progress root with the maintained track and indicator parts.
 *
 * @remarks Primary category: UI primitive adapter. Base UI progress-root props,
 * children, and required `value` are forwarded; the parent owns that value
 * (including `null` for indeterminate progress), while Base UI coordinates
 * progress accessibility semantics and state attributes. This wrapper always
 * composes a {@link ProgressTrack} and {@link ProgressIndicator}; the root
 * provides required context and exposes `data-slot`. A supplied `ref` targets
 * the root's `HTMLDivElement` host.
 * @param props - Base UI progress-root props, children, and required value.
 * @returns The progress root with its track and indicator.
 */
function Progress({
  className,
  children,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

/**
 * Renders the visual track for a {@link Progress} root.
 *
 * @remarks Primary category: UI primitive adapter. Base UI track props and
 * children are forwarded and marked with `data-slot="progress-track"`; a
 * {@link Progress} root is required and its missing-context error propagates
 * from Base UI. A supplied `ref` targets the track's `HTMLDivElement` host.
 * This part owns no value state, portal, keyboard behavior, or failure
 * handling.
 * @param props - Base UI progress-track props and children.
 * @returns The styled progress track.
 */
function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-[3px] w-full items-center overflow-x-hidden rounded-[var(--radius-capsule)] bg-[var(--app-control-track)]",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

/**
 * Renders the value indicator inside a {@link ProgressTrack}.
 *
 * @remarks Primary category: UI primitive adapter. Base UI indicator props and
 * children are forwarded and marked with `data-slot="progress-indicator"`;
 * the parent-owned root value determines its extent. A {@link Progress} root
 * is required and its missing-context error propagates from Base UI. A supplied
 * `ref` targets the indicator's `HTMLDivElement` host; this part owns no state,
 * portal, keyboard behavior, or failure handling.
 * @param props - Base UI progress-indicator props and children.
 * @returns The styled progress indicator.
 */
function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        "h-full rounded-[var(--radius-capsule)] bg-[var(--app-action)] transition-[width] duration-(--duration-standard) ease-(--ease-standard)",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders an accessible label associated with a {@link Progress} root.
 *
 * @remarks Primary category: UI primitive adapter. Base UI label props and
 * children are forwarded and marked with `data-slot="progress-label"`; a
 * {@link Progress} root is required and its missing-context error propagates
 * from Base UI, which owns the relationship to its root. A supplied `ref`
 * targets the label's `HTMLSpanElement` host; this part owns no value state,
 * portal, keyboard behavior, or failure handling.
 * @param props - Base UI progress-label props and label content.
 * @returns The styled progress label.
 */
function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

/**
 * Renders the formatted value text for a {@link Progress} root.
 *
 * @remarks Primary category: UI primitive adapter. Base UI value props and
 * value props are forwarded and the host is marked with
 * `data-slot="progress-value"`; a {@link Progress} root is required and its
 * missing-context error propagates from Base UI, which derives or formats the
 * displayed value from the parent-owned root value. A supplied `ref` targets
 * the value's `HTMLSpanElement` host; this part owns no state, portal, keyboard
 * behavior, or failure handling.
 * @param props - Base UI progress-value props and value content.
 * @returns The styled progress value.
 */
function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-sm text-muted-foreground tabular-nums",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  )
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue
}
