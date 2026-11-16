import { describe, expect, it } from "vitest"
import {
  SpeechController,
  type SpeechControllerDeps,
  type SpeechObservation,
  type SpeechReply,
  type SpeechSocket,
  type SpeechSocketHandlers
} from "@/lib/speech/speech-controller"

const REPLY: SpeechReply = {
  conversationId: "conversation-1",
  replyId: "reply-1"
}
const REPLY_2: SpeechReply = {
  conversationId: "conversation-1",
  replyId: "reply-2"
}

const streaming = (
  reply: SpeechReply = REPLY,
  beganAsNewTurn = true
): SpeechObservation => ({
  kind: "streaming",
  reply,
  beganAsNewTurn
})

const settled = (
  reply: SpeechReply = REPLY,
  status: "completed" | "interrupted" | "failed" = "completed"
): SpeechObservation => ({ kind: "settled", reply, status })

const NONE: SpeechObservation = { kind: "none" }

/** A fake socket plus the traffic it received. */
type FakeSocket = SpeechSocket & {
  /** Path the socket was opened with. */
  readonly path: string
  /** Frames the controller received through this socket. */
  readonly frames: Uint8Array[]
  /** Closes the socket as the backend would, delivering `code`. */
  serverClose: (code: number) => void
}

function createFakePlayer() {
  const enqueued: Uint8Array[] = []
  const state = { stops: 0, resumes: 0 }
  return {
    enqueued,
    state,
    enqueue(frame: Uint8Array) {
      enqueued.push(frame)
    },
    stop() {
      state.stops += 1
    },
    resume() {
      state.resumes += 1
    }
  }
}

/** Builds a controller with fakes and the knobs tests turn. */
function createHarness() {
  const sockets: FakeSocket[] = []
  const player = createFakePlayer()
  const world = { focused: true, voiceReady: true }
  const deps: SpeechControllerDeps = {
    isFocused: () => world.focused,
    isVoiceReady: () => world.voiceReady,
    speechPath: (reply, from) =>
      `/api/v1/chat/${reply.conversationId}/replies/${reply.replyId}/speech?from=${from}`,
    notificationPath: (reply) =>
      `/api/v1/chat/${reply.conversationId}/replies/${reply.replyId}/notification`,
    openSocket: (path, handlers: SpeechSocketHandlers) => {
      let closed = false
      const socket: FakeSocket = {
        path,
        frames: [],
        close() {
          closed = true
          handlers.onClose(1000)
        },
        serverClose(code: number) {
          if (closed) return
          closed = true
          handlers.onClose(code)
        }
      }
      sockets.push(socket)
      // Attach a shim so tests can push audio frames, as voice does.
      ;(
        socket as FakeSocket & { pushAudio: (frame: Uint8Array) => void }
      ).pushAudio = (frame) => {
        if (closed) return
        handlers.onAudio(frame)
      }
      return socket
    },
    createPlayer: () => player
  }
  const controller = new SpeechController(deps)
  return { controller, sockets, player, world }
}

/** The last socket opened, for the test to drive. */
function lastSocket(
  harness: ReturnType<typeof createHarness>
): FakeSocket & { pushAudio: (frame: Uint8Array) => void } {
  const socket = harness.sockets.at(-1)
  if (socket === undefined) throw new Error("no socket was opened")
  return socket as FakeSocket & { pushAudio: (frame: Uint8Array) => void }
}

const PCM = new Uint8Array([1, 0, 255, 127, 0, 128])

describe("speech controller", () => {
  it("reads a reply that streams while the window is focused and voice is ready, from the first word", () => {
    const harness = createHarness()
    const { controller, sockets, player } = harness

    controller.update(streaming(REPLY, true))

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.path).toBe(
      "/api/v1/chat/conversation-1/replies/reply-1/speech?from=start"
    )
    lastSocket(harness).pushAudio(PCM)
    expect(player.enqueued).toEqual([PCM])
  })

  it("joins a reply that was already running somewhere else at the sentence being written", () => {
    const { controller, sockets, player } = createHarness()

    controller.update(streaming(REPLY, false))

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.path).toContain("from=current")
    expect(player.enqueued).toHaveLength(0)
  })

  it("waits silently while the window is unfocused, and neither opens a socket nor plays anything", () => {
    const { controller, sockets, player, world } = createHarness()
    world.focused = false

    controller.update(streaming(REPLY, true))

    expect(sockets).toHaveLength(0)
    expect(player.enqueued).toHaveLength(0)
  })

  it("joins at the sentence being written when the window regains focus mid-reply", () => {
    const { controller, sockets, world } = createHarness()
    world.focused = false
    controller.update(streaming(REPLY, true))
    expect(sockets).toHaveLength(0)

    world.focused = true
    controller.update(streaming(REPLY, false))

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.path).toContain("from=current")
  })

  it("keeps reading when the window loses focus mid-reply", () => {
    const harness = createHarness()
    const { controller, sockets, player, world } = harness
    controller.update(streaming(REPLY, true))
    const socket = lastSocket(harness)
    void player

    world.focused = false
    controller.update(streaming(REPLY, true))

    expect(sockets).toHaveLength(1)
    socket.pushAudio(PCM)
    expect(sockets[0]).toBeDefined()
  })

  it("speaks nothing when the reply finishes unheard in the background, and says one notification line", () => {
    const { controller, sockets, world } = createHarness()
    world.focused = false
    controller.update(streaming(REPLY, true))

    controller.update(settled(REPLY, "completed"))

    expect(sockets.map((socket) => socket.path)).toEqual([
      "/api/v1/chat/conversation-1/replies/reply-1/notification"
    ])
  })

  it("says nothing when the reply finishes unheard while focused", () => {
    const { controller, sockets, world } = createHarness()
    world.focused = false
    controller.update(streaming(REPLY, true))
    world.focused = true

    controller.update(settled(REPLY, "completed"))

    expect(sockets).toHaveLength(0)
  })

  it("says nothing when the reply finished audibly", () => {
    const harness = createHarness()
    const { controller, sockets, player } = harness
    controller.update(streaming(REPLY, true))
    lastSocket(harness).pushAudio(PCM)

    controller.update(settled(REPLY, "completed"))

    expect(player.state.stops).toBe(0)
    expect(sockets.map((s) => s.path)).not.toContain(
      "/api/v1/chat/conversation-1/replies/reply-1/notification"
    )
  })

  it("lets the socket finish draining after the reply completes, without cutting audio", () => {
    const harness = createHarness()
    const { controller, sockets, player } = harness
    controller.update(streaming(REPLY, true))
    lastSocket(harness).pushAudio(PCM)

    controller.update(settled(REPLY, "completed"))
    expect(player.state.stops).toBe(0)

    sockets[0]?.serverClose(1000)
    expect(player.state.stops).toBe(0)
  })

  it("stops at once when the reply is interrupted or fails, dropping unplayed audio", () => {
    const { controller, sockets, player } = createHarness()
    controller.update(streaming(REPLY, true))

    controller.update(settled(REPLY, "interrupted"))

    expect(player.state.stops).toBe(1)
    controller.update(streaming(REPLY_2, true))
    expect(sockets).toHaveLength(2)
  })

  it("stops when the person sends a new message", () => {
    const { controller, player } = createHarness()
    controller.update(streaming(REPLY, true))

    controller.update(NONE)

    expect(player.state.stops).toBe(1)
  })

  it("stops when the conversation is switched or closed", () => {
    const { controller, player } = createHarness()
    controller.update(streaming(REPLY, true))

    controller.update(NONE)

    expect(player.state.stops).toBe(1)
  })

  it("stops the speech when the voice process stops mid-reply", () => {
    const { controller, sockets, player, world } = createHarness()
    controller.update(streaming(REPLY, true))

    world.voiceReady = false
    controller.update(streaming(REPLY, true))

    expect(sockets[0]).toBeDefined()
    expect(player.state.stops).toBe(1)
  })

  it("joins at the sentence being written once voice becomes ready mid-reply", () => {
    const { controller, sockets, world } = createHarness()
    world.voiceReady = false
    controller.update(streaming(REPLY, true))
    expect(sockets).toHaveLength(0)

    world.voiceReady = true
    controller.update(streaming(REPLY, true))

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.path).toContain("from=current")
  })

  it("drops the older speech when a newer reply starts", () => {
    const { controller, sockets, player } = createHarness()
    controller.update(streaming(REPLY, true))
    const firstStops = player.state.stops

    controller.update(streaming(REPLY_2, true))

    expect(player.state.stops).toBeGreaterThan(firstStops)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]?.path).toContain("reply-2")
  })

  it("only speaks for a new turn from the first word once each time status moves", () => {
    const { controller, sockets } = createHarness()
    controller.update(streaming(REPLY, true))
    controller.update(streaming(REPLY, true))

    expect(sockets).toHaveLength(1)
  })

  it("notifies only once for one reply", () => {
    const { controller, sockets, world } = createHarness()
    world.focused = false
    controller.update(streaming(REPLY, true))
    controller.update(settled(REPLY, "completed"))
    controller.update(settled(REPLY, "completed"))

    const notifications = sockets.filter((socket) =>
      socket.path.endsWith("/notification")
    )
    expect(notifications).toHaveLength(1)
  })

  it("stops playback when the speech socket closes without 1000", () => {
    const { controller, sockets, player } = createHarness()
    controller.update(streaming(REPLY, true))

    sockets[0]?.serverClose(1011)

    expect(player.state.stops).toBe(1)
  })

  it("does not double-notify when the same settled reply is reported twice", () => {
    const { controller, sockets, world } = createHarness()
    world.focused = false
    controller.update(streaming(REPLY, true))
    controller.update(settled(REPLY, "completed"))
    controller.update(settled(REPLY, "completed"))

    expect(
      sockets.filter((socket) => socket.path.endsWith("/notification"))
    ).toHaveLength(1)
  })
})
