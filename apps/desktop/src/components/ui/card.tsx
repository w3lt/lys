import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Renders the root surface for a composed card over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded; `size` is a repository spacing variant with
 * `default` or `sm` and defaults to `default`. The root exposes
 * `data-slot="card"` and `data-size` for its compound parts. A supplied `ref`
 * targets the native `HTMLDivElement`; the root owns no state, portal,
 * callbacks, or failure handling.
 * @param props - Native card props, children, and optional size.
 * @returns The styled card root surface.
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  /** Repository spacing variant applied to the card surface. */
  size?: "default" | "sm"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-[var(--radius-surface)] bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-[var(--radius-surface)] *:[img:last-child]:rounded-b-[var(--radius-surface)]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders the header region of a {@link Card} over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-header"`; nested
 * title, description, and action parts use that region's layout contract. A
 * supplied `ref` targets the native `HTMLDivElement`; no state, portal,
 * callbacks, or failure handling is owned here.
 * @param props - Native header props and children.
 * @returns The styled card header region.
 */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-[var(--radius-surface)] px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders title content in a {@link CardHeader} over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-title"`; the
 * component does not create a heading element or own state, portals, callbacks,
 * or failures. A supplied `ref` targets the native `HTMLDivElement`.
 * @param props - Native title props and children.
 * @returns The styled card title region.
 */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders supporting description content in a {@link CardHeader}.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-description"`.
 * Semantics remain those supplied by the caller because the host is a `div`.
 * A supplied `ref` targets the native `HTMLDivElement`; no state, portal,
 * callbacks, or failure handling is owned here.
 * @param props - Native description props and children.
 * @returns The styled card description region.
 */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Places action content in the trailing area of a {@link CardHeader}.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-action"`; layout
 * ownership remains with the surrounding header. A supplied `ref` targets the
 * native `HTMLDivElement`; it owns no state, portal, callbacks, or failure
 * handling.
 * @param props - Native action-region props and children.
 * @returns The positioned card action region.
 */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders the main content region of a {@link Card} over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-content"`; the
 * card root supplies the spacing context. A supplied `ref` targets the native
 * `HTMLDivElement`; it owns no state, portal, callbacks, or failure handling.
 * @param props - Native content props and children.
 * @returns The styled card content region.
 */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

/**
 * Renders the footer region of a {@link Card} over a native `div`.
 *
 * @remarks Native `div` props and
 * children are forwarded and marked with `data-slot="card-footer"`; the card
 * root adjusts its bottom spacing when this part is present. A supplied `ref`
 * targets the native `HTMLDivElement`; it owns no state, portal, callbacks, or
 * failure handling.
 * @param props - Native footer props and children.
 * @returns The styled card footer region.
 */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-[var(--radius-surface)] border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent
}
