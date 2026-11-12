import { activityEventSchema, type ActivityEvent } from "@lys/protocol"
import type { Job } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import ActivityHub from "../../../../../src/modules/activity/activityHub"
import registerActivityRoutes from "../../../../../src/modules/activity/routes"
import { parseSseEvents } from "../../../support/chatSseRoute"
import {
  createFixtureUuidV7,
  FIXTURE_TIMESTAMP
} from "../../../support/conversationFixtures"
import {
  createTestFastify,
  type CapturedLogDestination
} from "../../../support/fastifyTestApp"
import { waitForMicrotasks } from "../../../support/microtasks"

/** Published path of the activity stream. */
const ACTIVITY_EVENTS_PATH = "/api/v1/activity/events"

/** Main conversation the reported job was started from. */
const MAIN_CONVERSATION_ID = createFixtureUuidV7(1)

/** A job the hub reports while a client is connected. */
const WORKING_JOB = Object.freeze({
  id: createFixtureUuidV7(2),
  number: 1,
  agentCode: "lysiptera",
  title: "Compare the two plans",
  state: "working",
  latestNote: null,
  replyId: createFixtureUuidV7(3),
  jobCallIds: Object.freeze([createFixtureUuidV7(20)]),
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
} satisfies Job)

/** Snapshot of a hub that follows no reply. */
const EMPTY_SNAPSHOT = Object.freeze({
  type: "activity-snapshot",
  replies: []
} satisfies ActivityEvent)

/**
 * Creates an application with the HTTP transport and the activity routes
 * registered over a real hub.
 *
 * @returns The application, the destination of its log, the hub the routes
 * read, and a promise that settles once a request has opened its stream on
 * the hub, so an event the case sends afterwards reaches that stream.
 * @remarks When the test finishes, the hub is closed first, which ends every
 * stream still open, then the application.
 */
async function createActivityRouteApp() {
  const testFastify = createTestFastify()
  const hub = new ActivityHub()
  onTestFinished(() => {
    hub.close()
  })
  const openStream = hub.openStream.bind(hub)
  const streamOpening = Promise.withResolvers<void>()
  vi.spyOn(hub, "openStream").mockImplementation((sendEvent) => {
    const stream = openStream(sendEvent)
    streamOpening.resolve()
    return stream
  })
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("activityHub", hub)
  await registerActivityRoutes(testFastify.app)
  return { ...testFastify, hub, streamOpened: streamOpening.promise }
}

/**
 * Lists the lines the activity routes wrote to a test application's log.
 *
 * @param log - Destination of the application's log.
 * @returns The records whose message starts with `Activity stream`, in write
 * order.
 */
function listActivityLogLines(log: CapturedLogDestination) {
  return log.records.filter(
    (record) =>
      typeof record.msg === "string" && record.msg.startsWith("Activity stream")
  )
}

describe("registerActivityRoutes", () => {
  it("answers the published activity path with an event stream that starts with activity-snapshot and no reply, and ends it when the hub closes", async () => {
    const { app, hub, streamOpened } = await createActivityRouteApp()

    const responsePromise = app.inject({
      method: "GET",
      url: ACTIVITY_EVENTS_PATH,
      headers: { accept: "text/event-stream" }
    })
    await streamOpened
    hub.close()
    const response = await responsePromise

    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(parseSseEvents(response.body)).toEqual([
      { event: "activity-snapshot", data: EMPTY_SNAPSHOT }
    ])
  })

  it("sends an event of the hub to a connected client under the event's type, as the activity contract defines it", async () => {
    const { app, hub, streamOpened } = await createActivityRouteApp()

    const responsePromise = app.inject({
      method: "GET",
      url: ACTIVITY_EVENTS_PATH,
      headers: { accept: "text/event-stream" }
    })
    await streamOpened
    // The stream stays open while nothing happens: the update below is sent
    // a full turn of the event loop after the client connected.
    await waitForMicrotasks()
    hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
    hub.close()
    const response = await responsePromise

    const events = parseSseEvents(response.body)
    expect(events).toEqual([
      { event: "activity-snapshot", data: EMPTY_SNAPSHOT },
      {
        event: "job-updated",
        data: {
          type: "job-updated",
          parentConversationId: MAIN_CONVERSATION_ID,
          job: WORKING_JOB
        }
      }
    ])
    for (const { data } of events)
      expect(activityEventSchema.safeParse(data).success).toBe(true)
  })

  it("writes one info log line when a client connects and one when its stream closes", async () => {
    const { app, hub, log, streamOpened } = await createActivityRouteApp()

    const responsePromise = app.inject({
      method: "GET",
      url: ACTIVITY_EVENTS_PATH,
      headers: { accept: "text/event-stream" }
    })
    await streamOpened
    const linesWhileConnected = listActivityLogLines(log)
    hub.close()
    await responsePromise

    expect(linesWhileConnected).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "Activity stream connected"
      })
    ])
    expect(listActivityLogLines(log)).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "Activity stream connected"
      }),
      expect.objectContaining({ level: "info", msg: "Activity stream closed" })
    ])
  })

  it("ends the response without an event when the hub is already closed", async () => {
    const { app, hub } = await createActivityRouteApp()
    hub.close()

    const response = await app.inject({
      method: "GET",
      url: ACTIVITY_EVENTS_PATH,
      headers: { accept: "text/event-stream" }
    })

    expect(parseSseEvents(response.body)).toEqual([])
  })

  it("registers the activity path for GET only", async () => {
    const { app } = await createActivityRouteApp()

    const response = await app.inject({
      method: "POST",
      url: ACTIVITY_EVENTS_PATH
    })

    expect(response.statusCode).toBe(404)
  })
})
