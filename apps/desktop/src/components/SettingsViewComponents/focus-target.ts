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
