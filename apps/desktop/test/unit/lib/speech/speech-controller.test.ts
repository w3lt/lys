import { describe, expect, it } from "vitest"
import {
  SpeechController,
  type SpeechObservation,
  type SpeechReply,
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

const PCM = new Uint8Array([1, 0, 255, 127, 0, 128])

/** Close code a client's own close is reported with. */
const CLIENT_CLOSE = 1005

/**
 * Builds a streaming observation.
 *
 * @param reply - The streaming reply.
 * @param beganAsNewTurn - Whether the person asked for it.
 */
function streaming(
  reply: SpeechReply = REPLY,
  beganAsNewTurn = true
): SpeechObservation {
  return { kind: "streaming", reply, beganAsNewTurn }
}

/**
 * Builds a settled observation.
 *
 * @param reply - The settled reply.
 * @param status - How it ended.
 */
function settled(
  reply: SpeechReply = REPLY,
  status: "completed" | "interrupted" | "failed" = "completed"
): SpeechObservation {
  return { kind: "settled", reply, status }
}

const NONE: SpeechObservation = { kind: "none" }

/** A fake socket the test drives as the backend would. */
type FakeSocket = {
  /** Path the socket was opened with. */
  readonly path: string
  /** Whether the socket closed, from either side. */
  isClosed: boolean
  /** Closes the socket from the client side, as the controller does. */
  close: () => void
  /** Delivers one audio frame, as the backend relays voice's audio. */
  pushAudio: (frame: Uint8Array) => void
  /** Closes the socket from the backend side with `code`. */
  serverClose: (code: number) => void
}

/** A fake player that records what it was asked. */
type FakePlayer = {
  /** Frames enqueued, in order. */
  readonly enqueued: Uint8Array[]
  /** How many times `stop` ran. */
  stops: number
  /** How many times `resume` ran. */
  resumes: number
  /** Whether `close` ran. */
  isClosed: boolean
  enqueue: (frame: Uint8Array) => void
  stop: () => void
  resume: () => void
  close: () => void
}

/** Creates a fake player. */
function createFakePlayer(): FakePlayer {
  const player: FakePlayer = {
    enqueued: [],
    stops: 0,
    resumes: 0,
    isClosed: false,
    enqueue: (frame) => player.enqueued.push(frame),
    stop: () => {
      player.stops += 1
    },
    resume: () => {
      player.resumes += 1
    },
    close: () => {
      player.isClosed = true
    }
  }
  return player
}

/**
 * Opens a fake socket over the controller's handlers.
 *
 * @param path - The path the controller asked for.
 * @param handlers - The controller's handlers.
 */
function createFakeSocket(
  path: string,
  handlers: SpeechSocketHandlers
): FakeSocket {
  const socket: FakeSocket = {
    path,
    isClosed: false,
    close: () => socket.serverClose(CLIENT_CLOSE),
    pushAudio: (frame) => {
      if (!socket.isClosed) handlers.onAudio(frame)
    },
    serverClose: (code) => {
      if (socket.isClosed) return
      socket.isClosed = true
      handlers.onClose(code)
    }
  }
  return socket
}

/** A controller over fakes, with the knobs tests turn. */
type Harness = Readonly<{
  controller: SpeechController
  /** Every socket opened, in order. */
  sockets: FakeSocket[]
  player: FakePlayer
  /** Focus and voice readiness the controller reads. */
  world: { focused: boolean; voiceReady: boolean }
  /** How many times the controller asked to recheck voice. */
  rechecks: { count: number }
}>

/** Builds a controller with fakes. */
function createHarness(): Harness {
  const sockets: FakeSocket[] = []
  const player = createFakePlayer()
  const world = { focused: true, voiceReady: true }
  const rechecks = { count: 0 }
  const controller = new SpeechController({
    isFocused: () => world.focused,
    isVoiceReady: () => world.voiceReady,
    speechPath: (reply, from) => `${reply.replyId}/speech?from=${from}`,
    notificationPath: (reply) => `${reply.replyId}/notification`,
    openSocket: (path, handlers) => {
      const socket = createFakeSocket(path, handlers)
      sockets.push(socket)
      return socket
    },
    createPlayer: () => player,
    recheckVoice: () => {
      rechecks.count += 1
    }
  })
  return { controller, sockets, player, world, rechecks }
}

/**
 * The socket opened at `index`, for the test to drive.
 *
 * @param harness - The harness.
 * @param index - Position in opening order; the last one by default.
 */
function socketAt(harness: Harness, index = -1): FakeSocket {
  const socket = harness.sockets.at(index)
  if (socket === undefined) throw new Error("no such socket was opened")
  return socket
}

/** The paths of every socket opened, in order. */
function openedPaths(harness: Harness): string[] {
  return harness.sockets.map((socket) => socket.path)
}

describe("speech controller: when she reads", () => {
  it("reads a reply the person asked for from its first word", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    expect(openedPaths(harness)).toEqual(["reply-1/speech?from=start"])
    socketAt(harness).pushAudio(PCM)
    expect(harness.player.enqueued).toEqual([PCM])
  })

  it("joins a reply the view did not start at the sentence being written", () => {
    const harness = createHarness()
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual(["reply-1/speech?from=current"])
  })

  it("waits silently while the window is not focused, and joins on focus", () => {
    const harness = createHarness()
    harness.world.focused = false
    harness.controller.update(streaming())
    expect(harness.sockets).toHaveLength(0)
    harness.world.focused = true
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual(["reply-1/speech?from=current"])
  })

  it("waits while voice is not ready, and joins once it is", () => {
    const harness = createHarness()
    harness.world.voiceReady = false
    harness.controller.update(streaming())
    expect(harness.sockets).toHaveLength(0)
    harness.world.voiceReady = true
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual(["reply-1/speech?from=current"])
  })

  it("closes the socket and waits when focus is lost before anything was said", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const first = socketAt(harness)
    harness.world.focused = false
    harness.controller.update(streaming(REPLY, false))
    expect(first.isClosed).toBe(true)
    harness.world.focused = true
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual([
      "reply-1/speech?from=start",
      "reply-1/speech?from=current"
    ])
  })

  it("reads on to the end when focus is lost while reading", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const socket = socketAt(harness)
    socket.pushAudio(PCM)
    harness.world.focused = false
    harness.controller.update(streaming(REPLY, false))
    socket.pushAudio(PCM)
    harness.controller.update(settled())
    socket.pushAudio(PCM)
    expect(socket.isClosed).toBe(false)
    expect(harness.player.enqueued).toHaveLength(3)
    expect(harness.sockets).toHaveLength(1)
    socket.serverClose(1000)
    expect(harness.player.stops).toBe(0)
  })

  it("keeps a focused reply's socket open after done until the backend's 1000", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const socket = socketAt(harness)
    harness.controller.update(settled())
    expect(socket.isClosed).toBe(false)
    socket.pushAudio(PCM)
    expect(harness.player.enqueued).toEqual([PCM])
    socket.serverClose(1000)
    expect(harness.player.stops).toBe(0)
    expect(harness.sockets).toHaveLength(1)
  })

  it("says one notification line for a reply that ended in the background before anything was said", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const speech = socketAt(harness)
    harness.world.focused = false
    harness.controller.update(settled())
    expect(speech.isClosed).toBe(true)
    expect(openedPaths(harness)).toEqual([
      "reply-1/speech?from=start",
      "reply-1/notification"
    ])
    socketAt(harness).pushAudio(PCM)
    expect(harness.player.enqueued).toEqual([PCM])
    harness.controller.update(settled())
    expect(harness.sockets).toHaveLength(2)
  })

  it("notifies for a reply that streamed and ended entirely in the background", () => {
    const harness = createHarness()
    harness.world.focused = false
    harness.controller.update(streaming())
    harness.controller.update(settled())
    harness.controller.update(settled())
    expect(openedPaths(harness)).toEqual(["reply-1/notification"])
  })

  it("does not notify for a reply part of which was said", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    socketAt(harness).pushAudio(PCM)
    harness.world.focused = false
    harness.controller.update(settled())
    expect(openedPaths(harness)).toEqual(["reply-1/speech?from=start"])
  })

  it("does nothing for a reply it never saw stream", () => {
    const harness = createHarness()
    harness.world.focused = false
    harness.controller.update(settled())
    expect(harness.sockets).toHaveLength(0)
  })

  it.each(["interrupted", "failed"] as const)(
    "stops at once when the reply is %s",
    (status) => {
      const harness = createHarness()
      harness.controller.update(streaming())
      const socket = socketAt(harness)
      socket.pushAudio(PCM)
      harness.controller.update(settled(REPLY, status))
      expect(socket.isClosed).toBe(true)
      expect(harness.player.stops).toBe(1)
      expect(harness.sockets).toHaveLength(1)
    }
  )

  it("stops at once when a new message is sent or the conversation is switched", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const socket = socketAt(harness)
    socket.pushAudio(PCM)
    harness.controller.update(NONE)
    expect(socket.isClosed).toBe(true)
    expect(harness.player.stops).toBe(1)
    socket.pushAudio(PCM)
    expect(harness.player.enqueued).toHaveLength(1)
  })

  it("replaces the open reply when another reply streams", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const first = socketAt(harness)
    harness.controller.update(streaming(REPLY_2))
    expect(first.isClosed).toBe(true)
    expect(harness.player.stops).toBe(1)
    expect(openedPaths(harness)).toEqual([
      "reply-1/speech?from=start",
      "reply-2/speech?from=start"
    ])
  })

  it("stops at once when voice stops, and joins again once voice is ready", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const first = socketAt(harness)
    first.pushAudio(PCM)
    harness.world.voiceReady = false
    harness.controller.update(streaming(REPLY, false))
    expect(first.isClosed).toBe(true)
    expect(harness.player.stops).toBe(1)
    harness.world.voiceReady = true
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual([
      "reply-1/speech?from=start",
      "reply-1/speech?from=current"
    ])
  })

  it("drops audio still queued after a 1000 close when voice stops", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const socket = socketAt(harness)
    socket.pushAudio(PCM)
    harness.controller.update(settled())
    socket.serverClose(1000)
    expect(harness.player.stops).toBe(0)
    harness.world.voiceReady = false
    harness.controller.update(settled())
    expect(harness.player.stops).toBe(1)
  })
})

describe("speech controller: sockets that close on their own", () => {
  it.each([1008, 1011, 4404, 4409, 4503])(
    "stops playback on %i and does not reopen on chat updates",
    (code) => {
      const harness = createHarness()
      harness.controller.update(streaming())
      socketAt(harness).pushAudio(PCM)
      socketAt(harness).serverClose(code)
      expect(harness.player.stops).toBe(1)
      harness.controller.update(streaming(REPLY, false))
      harness.controller.update(streaming(REPLY, false))
      expect(harness.sockets).toHaveLength(1)
    }
  )

  it("joins again when the window regains focus after a failed socket", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    socketAt(harness).serverClose(4503)
    harness.world.focused = false
    harness.controller.update(streaming(REPLY, false))
    harness.world.focused = true
    harness.controller.update(streaming(REPLY, false))
    expect(openedPaths(harness)).toEqual([
      "reply-1/speech?from=start",
      "reply-1/speech?from=current"
    ])
  })

  it.each([
    [4503, 1],
    [1011, 1],
    [4409, 0],
    [1000, 0]
  ])("asks to recheck voice after %i: %i times", (code, expected) => {
    const harness = createHarness()
    harness.controller.update(streaming())
    socketAt(harness).serverClose(code)
    expect(harness.rechecks.count).toBe(expected)
  })

  it("ignores audio and closes from a socket it already closed", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const first = socketAt(harness)
    harness.controller.update(NONE)
    first.isClosed = false
    first.pushAudio(PCM)
    first.serverClose(4503)
    expect(harness.player.enqueued).toHaveLength(0)
    expect(harness.rechecks.count).toBe(0)
  })
})

describe("speech controller: the notification socket", () => {
  /** Opens a notification for REPLY and returns its socket. */
  function openNotification(harness: Harness): FakeSocket {
    harness.world.focused = false
    harness.controller.update(streaming())
    harness.controller.update(settled())
    const socket = socketAt(harness)
    expect(socket.path).toBe("reply-1/notification")
    return socket
  }

  it("lets a notification that closed with 1000 play out", () => {
    const harness = createHarness()
    const notification = openNotification(harness)
    notification.pushAudio(PCM)
    notification.serverClose(1000)
    expect(harness.player.stops).toBe(0)
  })

  it("stops a notification that closed with another code", () => {
    const harness = createHarness()
    const notification = openNotification(harness)
    notification.pushAudio(PCM)
    notification.serverClose(1011)
    expect(harness.player.stops).toBe(1)
    expect(harness.rechecks.count).toBe(1)
  })

  it("closes the notification and drops its audio when a new message is sent", () => {
    const harness = createHarness()
    const notification = openNotification(harness)
    notification.pushAudio(PCM)
    harness.controller.update(NONE)
    expect(notification.isClosed).toBe(true)
    expect(harness.player.stops).toBe(1)
  })

  it("closes the notification before another reply speaks", () => {
    const harness = createHarness()
    const notification = openNotification(harness)
    harness.world.focused = true
    harness.controller.update(streaming(REPLY_2))
    expect(notification.isClosed).toBe(true)
    expect(harness.player.stops).toBe(1)
    notification.isClosed = false
    notification.pushAudio(PCM)
    expect(harness.player.enqueued).toHaveLength(0)
  })

  it("closes the notification when voice stops", () => {
    const harness = createHarness()
    const notification = openNotification(harness)
    harness.world.voiceReady = false
    harness.controller.update(settled())
    expect(notification.isClosed).toBe(true)
  })
})

describe("speech controller: close", () => {
  it("closes the sockets and the player, and ignores later updates", () => {
    const harness = createHarness()
    harness.controller.update(streaming())
    const socket = socketAt(harness)
    harness.controller.close()
    expect(socket.isClosed).toBe(true)
    expect(harness.player.isClosed).toBe(true)
    harness.controller.update(streaming(REPLY_2))
    expect(harness.sockets).toHaveLength(1)
    harness.controller.close()
  })

  it("closes an open notification", () => {
    const harness = createHarness()
    harness.world.focused = false
    harness.controller.update(streaming())
    harness.controller.update(settled())
    const notification = socketAt(harness)
    harness.controller.close()
    expect(notification.isClosed).toBe(true)
  })

  it("resumes the player only while voice is ready", () => {
    const harness = createHarness()
    harness.world.voiceReady = false
    harness.controller.update(NONE)
    expect(harness.player.resumes).toBe(0)
    harness.world.voiceReady = true
    harness.controller.update(NONE)
    expect(harness.player.resumes).toBe(1)
  })
})
