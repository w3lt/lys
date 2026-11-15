import { useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react"

/**
 * Handles the attachment of an element that takes focus when it appears, by
 * focusing it.
 *
 * @remarks Passed as a callback ref only while the element should take
 * focus, so React calls it once when it attaches the element.
 * @param element - Attached element, or null when React detaches it, which
 * is ignored.
 */
export function handleFocusTargetAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Reports whether keyboard focus has fallen back to the document.
 *
 * @returns Whether no element other than the body holds focus, as after the
 * focused element was removed.
 */
export function isDocumentFocusLost(): boolean {
  const { activeElement } = document
  return activeElement === null || activeElement === document.body
}

/**
 * Makes a control that its owner may remove while it has focus ask the
 * owner for its successor as it leaves.
 *
 * @param onFocusSuccessor - Requests that the owner move focus to the
 * control's successor; the one passed last is called, once, in the commit
 * that removes the control, and only when the control has focus then.
 * @returns The host for the control to attach to its node; it keeps its
 * identity for the control's lifetime.
 * @remarks The hook reads the node attached when the control appears. As
 * the control leaves, in the layout phase of the commit that removes it and
 * before its node is detached, the last moment its focus can be read, it
 * asks for the successor when that node has focus; a control that leaves
 * without focus asks for nothing. The owner moves focus with
 * {@link useFocusSuccessor}.
 */
export function useFocusedRemovalReport(
  onFocusSuccessor: () => void
): RefObject<HTMLElement | null> {
  const controlRef = useRef<HTMLElement>(null)

  /**
   * Handles the control's removal, by asking for its successor when the
   * control has focus.
   *
   * @param control - The control's node, still attached, or null when it was
   * never attached.
   */
  function handleControlRemoval(control: HTMLElement | null): void {
    if (control !== null && control === document.activeElement) {
      onFocusSuccessor()
    }
  }
  const handleRemoval = useEffectEvent(handleControlRemoval)

  useLayoutEffect(() => {
    const control = controlRef.current
    return () => handleRemoval(control)
  }, [])

  return controlRef
}

/**
 * Moves focus to a control's successor when the owner removes the control
 * while it has focus.
 *
 * @param isControlShown - Whether the owner shows the control; read
 * reactively, and the control is rendered exactly while it is true.
 * @param successorRef - Host of the element that takes focus after the
 * control; read when focus moves.
 * @returns The callback for the control's {@link useFocusedRemovalReport}
 * to call as it leaves with focus; every version of it keeps working for the
 * owner's lifetime.
 * @remarks An owner moves focus only when its own control had it: the
 * control asks for its successor in the commit that removes it, and focus
 * moves to the successor in the layout phase of that commit, when focus has
 * fallen to the document by then, so it never rests there. Nothing moves
 * when the control leaves without focus, when another element holds focus
 * by then, or when the whole owner leaves. A successor that is not attached,
 * or cannot take focus, as a field that is off, takes none.
 */
export function useFocusSuccessor(
  isControlShown: boolean,
  successorRef: RefObject<HTMLElement | null>
): () => void {
  const hasFocusedControlLeftRef = useRef(false)

  /**
   * Handles a change of whether the owner shows the control, by moving focus
   * to the successor once the control left with focus and focus fell back to
   * the document.
   *
   * @param isShown - Whether the owner shows the control after the change.
   */
  function handleShownChange(isShown: boolean): void {
    const hasFocusedControlLeft = hasFocusedControlLeftRef.current
    hasFocusedControlLeftRef.current = false
    if (isShown || !hasFocusedControlLeft) return

    if (isDocumentFocusLost()) successorRef.current?.focus()
  }
  const handleControlShownChange = useEffectEvent(handleShownChange)

  /** Handles the control's removal while it has focus, by recording it. */
  function handleFocusedControlRemoval(): void {
    hasFocusedControlLeftRef.current = true
  }

  useLayoutEffect(() => {
    handleControlShownChange(isControlShown)
  }, [isControlShown])

  return handleFocusedControlRemoval
}
