import * as React from "react"
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"

import { cn } from "@/lib/utils"

/**
 * Provides the root context and styled host for an avatar family.
 *
 * @remarks Base UI avatar root props
 * and children are forwarded; `size` is a repository styling variant with
 * `default` as its fallback and is exposed as `data-size` for descendant
 * styling. The Base UI root coordinates image-loading state and fallback
 * selection; a supplied `ref` targets its `HTMLSpanElement` host. This adapter
 * owns no portal, callbacks, or failure handling.
 * @param props - Base UI avatar root props, children, and optional size.
 * @returns The avatar root that provides context to image and fallback parts.
 */
function Avatar({
  className,
  size = "default",
  ...props
}: AvatarPrimitive.Root.Props & {
  /** Repository size variant applied to the avatar root and descendants. */
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders the image part of an {@link Avatar} using the Base UI image
 * contract.
 *
 * @remarks Base UI image props are
 * forwarded, and `data-slot="avatar-image"` identifies the part. Image
 * loading and fallback behavior remain owned by the Base UI avatar root; an
 * {@link Avatar} root is required and Base UI's missing-context error
 * propagates otherwise. A supplied `ref` targets the Base UI
 * `HTMLImageElement` host. No portal, state, or error contract is added here.
 * @param props - Base UI avatar image props.
 * @returns The styled avatar image part.
 */
function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full rounded-full object-cover",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders fallback content for an {@link Avatar} using the Base UI fallback
 * contract.
 *
 * @remarks Base UI fallback props and
 * children are forwarded, and `data-slot="avatar-fallback"` identifies this
 * part. The root controls when fallback content is shown after image loading;
 * an {@link Avatar} root is required and Base UI's missing-context error
 * propagates otherwise. A supplied `ref` targets the Base UI
 * `HTMLSpanElement` host. This adapter owns no state, portal, or failure
 * handling.
 * @param props - Base UI avatar fallback props and children.
 * @returns The styled avatar fallback part.
 */
function AvatarFallback({
  className,
  ...props
}: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders an optional badge anchored to an {@link Avatar} over a native `span`.
 *
 * @remarks Native `span` props and
 * children are forwarded, and the badge is sized from the ancestor avatar's
 * `data-size` state. A supplied `ref` targets the native `HTMLSpanElement`;
 * this is presentational content with no state, portal, keyboard behavior, or
 * failure handling of its own.
 * @param props - Native badge props and children.
 * @returns The positioned avatar badge.
 */
function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

/**
 * Groups multiple {@link Avatar} instances in an overlapping native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded, and descendant avatar slots receive the group ring
 * treatment. A supplied `ref` targets the native `HTMLDivElement`; the group
 * owns no state, portal, callbacks, or failure handling.
 * @param props - Native group props and avatar children.
 * @returns The overlapping avatar group host.
 */
function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a count or other summary content as a group-sized avatar surface.
 *
 * @remarks Native `div` props and
 * children are forwarded, and the host adapts its size from the surrounding
 * avatar group's descendant size data attributes. A supplied `ref` targets the
 * native `HTMLDivElement`; it owns no state, portal, callbacks, or failure
 * handling.
 * @param props - Native count-surface props and summary content.
 * @returns The styled avatar group count surface.
 */
function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge
}
