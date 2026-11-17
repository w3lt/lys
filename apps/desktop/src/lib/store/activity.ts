import type { ActivityEvent } from "@lys/protocol"
import {
  ActivityStreamOpenError,
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
 * Answers whether a failure of the activity stream's read is the read's own,
 * which the follow recovers from by opening the stream again.
 *
 * @param failure - Value the read threw.
 * @param signal - Signal of the follow.
 * @returns True for a failed connection, which the platform reports as a
 * `TypeError`, for a stream the backend refused to open, and for any failure
 * once the signal aborted; false for every other failure, such as an event
 * that is not JSON or does not match the contract.
 */
function isActivityReadFailure(failure: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    failure instanceof TypeError ||
    failure instanceof ActivityStreamOpenError
  )
}

/**
 * Reads the events of one activity stream, ending without a failure when the
 * read's own failure ends it.
 *
 * @param signal - Signal of the follow; its abort ends the read.
 * @returns An async generator yielding validated activity events, a snapshot
 * first. It completes when the backend closes the stream, and when a failure
 * that {@link isActivityReadFailure} recognizes ends the read.
 * @throws If an event is not JSON or does not match the contract, or if the
 * read fails in any other way that function does not recognize.
 * @remarks The backend origin is sampled when the read starts. Only the
 * read is covered: a failure of the code that takes an event is not caught
 * here, and ending the iteration cancels the stream.
 */
async function* readActivityEventsUntilReadFailure(
  signal: AbortSignal
): AsyncGenerator<ActivityEvent, void, unknown> {
  const connection: ActivityConnection = {
    backendUrl: useLysStore.getState().backendUrl,
    signal
  }
  try {
    yield* readActivityEvents(connection)
  } catch (readError) {
    if (!isActivityReadFailure(readError, signal)) throw readError
    // A failed read ends like one the backend closed, without a message or a
    // log entry: the next read starts with a snapshot that brings both
    // stores up to date.
  }
}

/**
 * Reads the activity stream once, from opening it until it ends, and hands
 * each event to the tool-call store, then to the chat view.
 *
 * @param signal - Signal of the follow; its abort ends the read.
 * @returns A promise that resolves once the backend has closed the stream,
 * once the read's own failure ended it, or once an event arrives after the
 * signal aborted; that event is not handed over.
 * @throws If an event is not JSON or does not match the contract, the
 * tool-call store rejects an event, or the chat view refuses a job update.
 * @remarks The tool-call store takes each event first, so when the chat
 * view reads the shown conversation again for the event, the tool-call
 * store already knows the replies the event announced and opens no
 * connection of its own for their calls. An event being handed over when
 * the signal aborts still reaches both stores.
 */
async function readActivityStream(signal: AbortSignal): Promise<void> {
  for await (const event of readActivityEventsUntilReadFailure(signal)) {
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
function waitForActivityReconnectDelay(signal: AbortSignal): Promise<void> {
  const reconnectDelayMs = 1000
  if (signal.aborted) return Promise.resolve()

  return new Promise<void>((resolve) => {
    /** Ends the wait, releasing the timer and the abort listener. */
    function endWait(): void {
      clearTimeout(reconnectTimer)
      signal.removeEventListener("abort", endWait)
      resolve()
    }
    const reconnectTimer = setTimeout(endWait, reconnectDelayMs)
    signal.addEventListener("abort", endWait, { once: true })
  })
}

/**
 * Follows the activity stream until the signal aborts, opening it again one
 * second after each read ends.
 *
 * @param signal - Signal of the follow; its abort ends the read or the wait
 * under way, and no later read starts.
 * @returns A promise that resolves once the signal has aborted and the read
 * or wait under way has ended.
 * @throws If an event is not JSON or does not match the contract, or if a
 * store fails to handle one: the follow then ends at once, with the stream
 * cancelled and no new read.
 * @remarks A read ends when the backend closes the stream, when the stream
 * cannot be opened, or when the connection fails. Every read starts with a
 * snapshot that brings both stores up to date, so each of these ends is
 * followed by the same delay and a new read, without backoff, message, or
 * log entry.
 */
async function followActivityEvents(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await readActivityStream(signal)
  await waitForActivityReconnectDelay(signal)
  return followActivityEvents(signal)
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
 * second after each read ends. An event that is not JSON or does not match
 * the contract, or a store that fails to handle an event, ends the follow
 * instead: the failure goes to the platform's `reportError`, as an uncaught
 * one does, since the desktop has no logger, and no follow runs until the
 * backend's status leaves `running` and returns. Nothing reads whether the
 * stream is open. The application shell registers it once while it is
 * mounted; nothing subscribes when this module is evaluated.
 */
export function registerActivityFollow(): () => void {
  let followController: AbortController | undefined

  /**
   * Starts a follow at the application store's backend, and reports the
   * failure that ends it, if one does.
   */
  function startActivityFollow(): void {
    followController = new AbortController()
    followActivityEvents(followController.signal).catch(
      (followError: unknown) => {
        reportError(followError)
      }
    )
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
