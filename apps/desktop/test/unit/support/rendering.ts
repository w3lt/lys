import { act, createEvent, fireEvent } from "@testing-library/react"
import type { UserEvent } from "@testing-library/user-event"

import { waitForMicrotasks } from "./settlement"

/**
 * Lets pending requests, commands, and store updates settle inside a React
 * update scope, so the rendered output reflects them.
 *
 * @returns Resolves after the macrotask barrier of {@link waitForMicrotasks}
 * and the React updates it caused.
 */
export async function waitForRenderedWork(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
}

/**
 * Opens a menu from its focused trigger with the keyboard.
 *
 * @param user - User-event session of the case.
 * @param trigger - Menu trigger.
 * @returns Resolves after the key press was dispatched.
 * @remarks Base UI opens menus on a pointer press that jsdom does not
 * reproduce; Enter is the supported keyboard path to the same open state.
 */
export async function openMenuWithKeyboard(
  user: UserEvent,
  trigger: HTMLElement
): Promise<void> {
  trigger.focus()
  await user.keyboard("{Enter}")
}

/**
 * Lists the elements a mouse pointer is over while it rests on an element.
 *
 * @param element - Element the pointer rests on.
 * @returns The element and each element that contains it, outermost first,
 * as a browser sends them enter events.
 */
function listHoveredElements(element: Element): readonly Element[] {
  const hovered: Element[] = []
  for (
    let current: Element | null = element;
    current !== null;
    current = current.parentElement
  )
    hovered.unshift(current)
  return hovered
}

/**
 * Moves a mouse pointer onto an element from outside the document, with the
 * events a browser sends when a mouse enters an element and moves over it.
 *
 * @param element - Element the pointer comes to rest on.
 * @remarks Like a browser, it sends the enter events, which do not bubble,
 * to the element and to every element that contains it, so a component that
 * listens on an element around the target, such as a tooltip's trigger,
 * receives them. Dispatches synchronously, so it also works under fake
 * timers, where user-event's `hover` cannot complete: its settle step waits
 * on a timer that only the case could advance. A hover delay then runs on
 * the fake clock the case advances.
 */
export function startHover(element: HTMLElement): void {
  const hovered = listHoveredElements(element)
  fireEvent.pointerOver(element, { pointerType: "mouse" })
  for (const entered of hovered)
    fireEvent(
      entered,
      createEvent.pointerEnter(entered, { pointerType: "mouse" })
    )
  fireEvent.mouseOver(element)
  for (const entered of hovered)
    fireEvent(entered, createEvent.mouseEnter(entered))
  fireEvent.pointerMove(element, { pointerType: "mouse" })
  fireEvent.mouseMove(element)
}

/**
 * Moves a mouse pointer off an element and out of the document, with the
 * events a browser sends when a mouse leaves an element.
 *
 * @param element - Element the pointer leaves.
 * @remarks Like {@link startHover}, it sends the leave events to the element
 * and to every element that contains it, innermost first. Dispatches
 * synchronously.
 */
export function stopHover(element: HTMLElement): void {
  const left = [...listHoveredElements(element)].reverse()
  fireEvent.pointerOut(element, { pointerType: "mouse" })
  for (const leaving of left)
    fireEvent(
      leaving,
      createEvent.pointerLeave(leaving, { pointerType: "mouse" })
    )
  fireEvent.mouseOut(element)
  for (const leaving of left)
    fireEvent(leaving, createEvent.mouseLeave(leaving))
}
