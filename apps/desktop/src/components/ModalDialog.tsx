import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

import "./ModalDialog.scss"

/** Properties accepted by {@link ModalDialog}. */
export type ModalDialogProps = {
  /** Whether the dialog is currently presented. */
  readonly isOpen: boolean
  /**
   * Accessible name of the dialog.
   *
   * When the content renders a visible heading, this label must begin with
   * that heading's exact text.
   */
  readonly label: string
  /**
   * Requests that the owner hide the dialog.
   *
   * Invoked once for `Escape`, a press outside the surface, and any close
   * control rendered inside the content. The owner decides whether to accept
   * the request; the dialog stays presented until `isOpen` becomes false.
   */
  readonly onClose: () => void
  /** Caller-owned layout classes applied to the dialog surface. */
  readonly className?: string
  /** Complete dialog content, including any visible heading. */
  readonly children: ReactNode
}

/**
 * Presents repository content as a modal dialog over the application.
 *
 * @remarks Primary category: UI primitive adapter. It isolates the external
 * dialog primitive: the owner controls presentation through `isOpen` and
 * receives every dismissal through `onClose`, and no external prop, event, or
 * topology reaches consumers. While presented, the dialog traps keyboard
 * focus, makes the rest of the page inert, and locks page scrolling; closing
 * restores focus to the element that opened it. Content is unmounted while the
 * dialog is hidden, so content state does not survive a close.
 * @param props - Presentation state, accessible name, dismissal request,
 * surface layout classes, and dialog content.
 * @returns The dialog backdrop and surface, or nothing while hidden.
 */
export function ModalDialog({
  isOpen,
  label,
  onClose,
  className,
  children
}: ModalDialogProps): ReactElement {
  /**
   * Reports a dismissal requested through the external dialog primitive.
   *
   * @param open - Presentation state proposed by the primitive.
   */
  function handleOpenChange(open: boolean): void {
    if (open) return

    onClose()
  }

  return (
    <DialogPrimitive.Root
      disablePointerDismissal={false}
      modal={true}
      onOpenChange={handleOpenChange}
      open={isOpen}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="modal-dialog__backdrop" />
        <DialogPrimitive.Popup
          aria-label={label}
          className={cn("modal-dialog", className)}
          finalFocus={true}
          initialFocus={true}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
