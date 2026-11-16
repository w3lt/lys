import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"

import { cn } from "@/lib/utils"

/**
 * Provides the root context and styled host for an avatar family.
 *
 * @remarks Base UI avatar root props
 * and children are forwarded; `size` is a repository styling variant with
 * `default` as its fallback and is exposed as `data-size` for descendant
 * styling. The Base UI root coordinates image-loading state; a supplied `ref`
 * targets its `HTMLSpanElement` host. This adapter owns no portal, callbacks,
 * or failure handling.
 * @param props - Base UI avatar root props, children, and optional size.
 * @returns The avatar root that provides context to its image part.
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

export { Avatar, AvatarImage }
