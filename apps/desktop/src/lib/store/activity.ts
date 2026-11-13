import {
  readActivityEvents,
  type ActivityConnection
} from "@/lib/apis/http/activity"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"
import { useToolCallStore } from "@/lib/store/tool-calls"

/** Application state the activity follow observes. */
type ActivityFollowState = Pick<
  ReturnType<typeof useLysStore.getState>,
  "backendServerInfo"
>

/**
 * Reads the activity stream once, from opening it until it ends, and hands
 * each event to the tool-call store, then to the chat view.
 *
 * @param signal - Signal of the follow; its abort ends the read.
 * @returns A promise that resolves once the backend has closed the stream,
 * or once an event arrives after the signal aborted; that event is not
 * handed over.
 * @throws If the stream cannot be opened or read, an event does not match
 * the contract, the tool-call store rejects an event, or the signal aborts
 * while the read waits for the next event.
 * @remarks The backend origin is sampled when the read starts. The tool-call
 * store takes each event first, so when the chat view reads the shown
 * conversation again for the event, the tool-call store already knows the
 * replies the event announced and opens no connection of its own for their
 * calls. An event being handed over when the signal aborts still reaches
 * both stores.
 */
async function readActivityStream(signal: AbortSignal): Promise<void> {
  const connection: ActivityConnection = {
    backendUrl: useLysStore.getState().backendUrl,
    signal
  }
  for await (const event of readActivityEvents(connection)) {
    if (signal.aborted) return
    await useToolCallStore.getState().handleActivityEvent(event)
    useChatViewStore.getState().handleActivityEvent(event)
  }
}

/**
 * Waits until the activity stream may be opened again: one second, or until
 * the signal aborts.
 *
 * @param signal - Signal of the follow; its abort ends the wait at once.
 * @returns A promise that resolves once the second has passed or the signal
 * has aborted, at once when it already had; it never rejects.
 * @remarks The timer and the abort listener are released when the wait ends
 * either way, so a stopped follow leaves nothing scheduled.
 */
async function waitForActivityReconnectDelay(
  signal: AbortSignal
): Promise<void> {
  const reconnectDelayMs = 1000
  if (signal.aborted) return

  let endWait!: () => void
  const delay = new Promise<void>((resolve) => {
    endWait = resolve
  })
  const reconnectTimer = setTimeout(endWait, reconnectDelayMs)
  signal.addEventListener("abort", endWait, { once: true })
  try {
    await delay
  } finally {
    clearTimeout(reconnectTimer)
    signal.removeEventListener("abort", endWait)
  }
}

/**
 * Follows the activity stream until the signal aborts, opening it again one
 * second after each read ends.
 *
 * @param signal - Signal of the follow; its abort ends the read or the wait
 * under way, and no later read starts.
 * @returns A promise that resolves once the signal has aborted and the read
 * or wait under way has ended; it never rejects.
 * @remarks A read ends when the backend closes the stream, when the stream
 * cannot be opened or read, when an event does not match the contract, or
 * when the tool-call store rejects an event. Every read starts with a
 * snapshot that brings both stores up to date, so each of these ends is
 * followed by the same delay and a new read, without backoff, message, or log
 * entry.
 */
async function followActivityEvents(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await readActivityStream(signal)
    } catch {
      // A read that fails ends like one the backend closed: the next read
      // starts with a snapshot that brings both stores up to date.
    }
    await waitForActivityReconnectDelay(signal)
  }
}

/**
 * Starts following the activity stream while the backend runs.
 *
 * @returns The stop, which unsubscribes and stops the follow: the read or
 * the wait under way ends, and no event read after it reaches a store.
 * Calling it again does nothing.
 * @remarks Subscribes to the application store. One follow runs while the
 * backend's status is `running`, started when the backend starts running or
 * at once when it already runs at registration, and stopped when the status
 * leaves `running`. The stream reports the replies the backend starts
 * itself, such as a job's reply or a wake-up reply: each event goes to the
 * tool-call store, then to the chat view. The stream is opened again one
 * second after each read ends. Nothing reads whether the stream is open. The
 * application shell registers it once while it is mounted; nothing
 * subscribes when this module is evaluated.
 */
export function registerActivityFollow(): () => void {
  let followController: AbortController | undefined

  /** Starts a follow at the application store's backend. */
  function startActivityFollow(): void {
    followController = new AbortController()
    // Following never rejects and ends once its signal aborts.
    void followActivityEvents(followController.signal)
  }

  /** Stops the follow, if one runs. */
  function stopActivityFollow(): void {
    followController?.abort()
    followController = undefined
  }

  /**
   * Keeps one follow while the backend runs and none while it does not.
   *
   * @param state - Application state after a change, or at registration.
   */
  function updateActivityFollow(state: ActivityFollowState): void {
    if (state.backendServerInfo.status !== "running") {
      stopActivityFollow()
      return
    }
    if (followController === undefined) startActivityFollow()
  }

  const unsubscribe = useLysStore.subscribe(updateActivityFollow)
  updateActivityFollow(useLysStore.getState())

  return () => {
    unsubscribe()
    stopActivityFollow()
  }
}
