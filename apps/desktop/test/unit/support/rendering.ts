import { act, fireEvent } from "@testing-library/react"
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
 * Moves a mouse pointer onto an element, with the events a browser sends
 * when a mouse enters an element and moves over it.
 *
 * @param element - Element the pointer comes to rest on.
 * @remarks Dispatches synchronously, so it also works under fake timers,
 * where user-event's `hover` cannot complete: its settle step waits on a
 * timer that only the case could advance. A hover delay then runs on the
 * fake clock the case advances.
 */
export function startHover(element: HTMLElement): void {
  fireEvent.pointerOver(element, { pointerType: "mouse" })
  fireEvent.pointerEnter(element, { pointerType: "mouse" })
  fireEvent.mouseOver(element)
  fireEvent.mouseEnter(element)
  fireEvent.pointerMove(element, { pointerType: "mouse" })
  fireEvent.mouseMove(element)
}

/**
 * Moves a mouse pointer off an element, with the events a browser sends when
 * a mouse leaves an element.
 *
 * @param element - Element the pointer leaves.
 * @remarks Dispatches synchronously, like {@link startHover}.
 */
export function stopHover(element: HTMLElement): void {
  fireEvent.pointerOut(element, { pointerType: "mouse" })
  fireEvent.pointerLeave(element, { pointerType: "mouse" })
  fireEvent.mouseOut(element)
  fireEvent.mouseLeave(element)
}
