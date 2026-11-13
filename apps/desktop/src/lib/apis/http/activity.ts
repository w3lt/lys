import {
  activityEventSchema,
  activityEventsApi,
  type ActivityEvent
} from "@lys/protocol"
import { readServerSentEvents } from "./server-sent-events"

/** Transport scope sampled once for one read of the activity stream. */
export type ActivityConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
  /**
   * Ends this read of the stream; the replies and jobs it reports keep
   * running.
   */
  readonly signal: AbortSignal
}

/**
 * Opens and reads the backend's activity stream: the replies the backend
 * started, what they wait for, and the jobs they belong to.
 *
 * @param connection - Backend origin and the signal that ends this read.
 * @returns An async generator yielding validated activity events, a snapshot
 * first. It completes when the backend closes the stream, which happens only
 * when the backend shuts down or this client falls too far behind.
 * @throws If the request fails or the signal aborts; with
 * `The backend could not open the activity stream (HTTP <status>).` when the
 * backend answers without a stream; and if reading, JSON parsing, or event
 * validation fails.
 * @remarks Ending iteration or aborting the signal cancels the stream and
 * stops nothing on the backend. Nothing is replayed: a new read starts with a
 * new snapshot.
 */
export async function* readActivityEvents(
  connection: ActivityConnection
): AsyncGenerator<ActivityEvent, void, unknown> {
  const headers = { Accept: activityEventsApi.response.contentType }
  const response = await fetch(
    `${connection.backendUrl}${activityEventsApi.path}`,
    {
      method: activityEventsApi.method,
      headers,
      signal: connection.signal,
      cache: "no-store"
    }
  )

  if (!response.ok || !response.body) {
    throw new Error(
      `The backend could not open the activity stream (HTTP ${response.status}).`
    )
  }

  yield* readServerSentEvents(response.body, (value) =>
    activityEventSchema.parse(value)
  )
}
