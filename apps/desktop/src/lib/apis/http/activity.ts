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
 * Activity stream the backend refused to open: it answered with a failed
 * status, without a body, or with a body that is not an event stream.
 *
 * @remarks Its type tells the activity follow that the stream could not be
 * opened, so the follow opens it again later; its message names the status.
 * The subclass preserves the native `Error` contract.
 */
export class ActivityStreamOpenError extends Error {
  /**
   * Creates the error for one refused open.
   *
   * @param status - HTTP status the backend answered with.
   */
  public constructor(status: number) {
    super(
      `The backend could not open the activity stream (HTTP ${String(status)}).`
    )
  }
}

/**
 * Opens and reads the backend's activity stream: the replies the backend
 * started, what they wait for, and the jobs they belong to.
 *
 * @param connection - Backend origin and the signal that ends this read.
 * @returns An async generator yielding validated activity events, a snapshot
 * first. It completes when the backend closes the stream, which happens only
 * when the backend shuts down or this client falls too far behind.
 * @throws If the request fails or the signal aborts; an
 * {@link ActivityStreamOpenError} when the backend answers with a failed
 * status, without a body, or with a body that is not an event stream, after
 * cancelling that body; and if reading, JSON parsing, or event validation
 * fails.
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

  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  if (
    !response.ok ||
    !response.body ||
    mediaType !== activityEventsApi.response.contentType
  ) {
    await response.body?.cancel()
    throw new ActivityStreamOpenError(response.status)
  }

  yield* readServerSentEvents(response.body, (value) =>
    activityEventSchema.parse(value)
  )
}
