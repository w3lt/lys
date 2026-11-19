import { onTestFinished, vi } from "vitest"

/**
 * What the fake platform recorded of the dictations the code under test ran,
 * with the answers a case may replace.
 */
export type DictationPlatformFake = {
  /** WebSockets opened, in order. */
  readonly sockets: FakeWebSocket[]
  /** Constraints of each microphone request, in order. */
  readonly microphoneRequests: unknown[]
  /** Microphone streams the platform handed out, in order. */
  readonly streams: FakeMicrophoneStream[]
  /** Audio contexts created, in order. */
  readonly contexts: FakeAudioContext[]
  /** Worklet nodes created, in order. */
  readonly nodes: FakeWorkletNode[]
  /**
   * Answers a microphone request; a case replaces it to refuse the
   * microphone or to answer later.
   *
   * @returns The stream, or a rejection with the platform's error.
   */
  openMicrophone: () => Promise<FakeMicrophoneStream>
  /**
   * Answers the loading of a worklet module; a case replaces it to fail or
   * delay the load.
   *
   * @returns Settlement once the module is loaded.
   */
  loadWorkletModule: () => Promise<void>
}

/** The platform of the running case, which the fake classes record into. */
let runningPlatform: DictationPlatformFake | undefined

/**
 * Gets the platform of the running case.
 *
 * @returns The platform {@link startDictationPlatformFake} installed.
 * @throws {Error} When the case installed none.
 */
function getRunningPlatform(): DictationPlatformFake {
  if (runningPlatform === undefined)
    throw new Error("The case started no dictation platform fake")
  return runningPlatform
}

/**
 * One WebSocket the code under test opened.
 *
 * @remarks It follows the platform's socket where a dictation can tell: a
 * message sent while it connects throws, one sent while it closes or once it
 * closed is dropped, and a close from the client side is reported on a later
 * task, never inside the call.
 */
export class FakeWebSocket {
  /** State of a socket that is still connecting. */
  public static readonly CONNECTING = 0
  /** State of an open socket. */
  public static readonly OPEN = 1
  /** State of a socket whose close started and is not reported yet. */
  public static readonly CLOSING = 2
  /** State of a closed socket. */
  public static readonly CLOSED = 3
  /** The socket's state. */
  public readyState = FakeWebSocket.CONNECTING
  /** Messages sent, in order. */
  public readonly sent: unknown[] = []
  /** Whether `close` ran. */
  public isClosed = false
  /** Its listeners, by event type. */
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>()
  /** The platform of the case that opened it. */
  readonly #platform = getRunningPlatform()

  /**
   * Records the socket with the running case's platform.
   *
   * @param url - The URL it was opened with.
   */
  public constructor(public readonly url: string) {
    this.#platform.sockets.push(this)
  }

  /**
   * Adds a listener.
   *
   * @param type - Event type.
   * @param listener - The listener.
   */
  public addEventListener(type: string, listener: (event: unknown) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  /**
   * Sends a message, as the platform does: only an open socket takes it.
   *
   * @param message - The message.
   * @throws {DOMException} `InvalidStateError` while the socket connects.
   */
  public send(message: unknown): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new DOMException("Still in CONNECTING state.", "InvalidStateError")
    }
    if (this.readyState === FakeWebSocket.OPEN) this.sent.push(message)
  }

  /**
   * Closes the socket from the client side, as the platform does: the socket
   * is closing at once, and on a later task it is closed and reports its
   * `close` event. The event carries `1005` for a socket that was open,
   * because the client gave no code, and `1006` after an `error` event for
   * one that never opened. A close of a closing or closed socket does
   * nothing more.
   *
   * @remarks A close still waiting when the case finishes is never reported,
   * so it cannot reach the next case.
   */
  public close(): void {
    this.isClosed = true
    if (this.readyState >= FakeWebSocket.CLOSING) return
    const wasOpen = this.readyState === FakeWebSocket.OPEN
    this.readyState = FakeWebSocket.CLOSING
    setTimeout(() => {
      this.#handleClientCloseDone(wasOpen)
    }, 0)
  }

  /**
   * Reports the close the client started, unless the backend's close came
   * first or the case finished.
   *
   * @param wasOpen - Whether the socket was open when the client closed it.
   */
  #handleClientCloseDone(wasOpen: boolean): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    if (runningPlatform !== this.#platform) return
    if (!wasOpen) this.sendEvent("error")
    this.closeFromBackend(wasOpen ? 1005 : 1006)
  }

  /**
   * Delivers an event to its listeners, as the platform does.
   *
   * @param type - Event type.
   * @param event - The event.
   */
  public sendEvent(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  /**
   * Opens the socket, as the platform does once it connected.
   *
   * @throws {Error} When the socket is not connecting, which the platform
   * never opens.
   */
  public open(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) {
      throw new Error("The case opened a socket that is not connecting")
    }
    this.readyState = FakeWebSocket.OPEN
    this.sendEvent("open")
  }

  /**
   * Delivers one text message, as the backend sends it.
   *
   * @param message - The message, sent as JSON.
   */
  public sendJson(message: unknown): void {
    this.sendEvent("message", { data: JSON.stringify(message) })
  }

  /**
   * Closes the socket from the backend's side, or ends a close the client
   * started; a closed socket reports nothing more.
   *
   * @param code - The close code.
   */
  public closeFromBackend(code: number): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.sendEvent("close", { code })
  }
}

/** A microphone track, as a case drives it. */
export class FakeMicrophoneTrack {
  /** Whether the recorder stopped the track. */
  public isStopped = false
  /** Listeners of the track's end. */
  readonly #endedListeners: (() => void)[] = []

  /** Stops the track, as the recorder does. */
  public stop(): void {
    this.isStopped = true
  }

  /**
   * Adds a listener.
   *
   * @param _type - Event type; the recorder listens for `ended` only.
   * @param listener - The listener.
   */
  public addEventListener(_type: string, listener: () => void): void {
    this.#endedListeners.push(listener)
  }

  /** Reports the track's end, as unplugging the microphone does. */
  public sendEnded(): void {
    for (const listener of this.#endedListeners) listener()
  }
}

/** A microphone stream with one track. */
export class FakeMicrophoneStream {
  /** The stream's track. */
  public readonly track = new FakeMicrophoneTrack()

  /** Records the stream with the running case's platform. */
  public constructor() {
    getRunningPlatform().streams.push(this)
  }

  /**
   * Lists the stream's tracks.
   *
   * @returns Its one track.
   */
  public getTracks(): FakeMicrophoneTrack[] {
    return [this.track]
  }
}

/** A stand-in for the platform's audio context, which jsdom lacks. */
export class FakeAudioContext {
  /** Where the recorder's node connects. */
  public readonly destination = { name: "destination" }
  /** URLs of the worklet modules loaded. */
  public readonly modules: string[] = []
  /** What the microphone's source was connected to. */
  public readonly sourceConnections: unknown[] = []
  /** The stream a source was created for. */
  public sourceStream: unknown
  /** How many times the context was resumed. */
  public resumes = 0
  /** Whether the context was closed. */
  public isClosed = false
  /** The worklet of the context. */
  public readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url)
      return getRunningPlatform().loadWorkletModule()
    }
  }

  /** Records the context with the running case's platform. */
  public constructor() {
    getRunningPlatform().contexts.push(this)
  }

  /**
   * Creates the microphone's source.
   *
   * @param stream - The microphone's stream.
   * @returns A source that records what it is connected to.
   */
  public createMediaStreamSource(stream: unknown) {
    this.sourceStream = stream
    return {
      connect: (node: unknown) => {
        this.sourceConnections.push(node)
      }
    }
  }

  /**
   * Resumes the context.
   *
   * @returns Settlement at once.
   */
  public resume(): Promise<void> {
    this.resumes += 1
    return Promise.resolve()
  }

  /**
   * Closes the context.
   *
   * @returns Settlement at once.
   */
  public close(): Promise<void> {
    this.isClosed = true
    return Promise.resolve()
  }
}

/** A stand-in for the recorder's worklet node. */
export class FakeWorkletNode {
  /** The port to the processor. */
  public readonly port: { onmessage: ((event: unknown) => void) | null } = {
    onmessage: null
  }
  /** What the node was connected to. */
  public readonly connections: unknown[] = []

  /**
   * Records the node with the running case's platform.
   *
   * @param context - The node's context.
   * @param name - The processor's name.
   * @param options - The node's options.
   */
  public constructor(
    public readonly context: unknown,
    public readonly name: string,
    public readonly options: unknown
  ) {
    getRunningPlatform().nodes.push(this)
  }

  /**
   * Connects the node.
   *
   * @param destination - Where it connects.
   */
  public connect(destination: unknown): void {
    this.connections.push(destination)
  }

  /**
   * Posts a message from the processor.
   *
   * @param data - The message's data.
   */
  public sendMessage(data: unknown): void {
    this.port.onmessage?.({ data })
  }
}

/**
 * Handles a request for the microphone with the running case's platform.
 *
 * @param constraints - What the recorder asked for.
 * @returns The platform's answer.
 */
function handleMicrophoneRequest(
  constraints: unknown
): Promise<FakeMicrophoneStream> {
  const platform = getRunningPlatform()
  platform.microphoneRequests.push(constraints)
  return platform.openMicrophone()
}

/**
 * Removes the fake microphone from the navigator and forgets the case's
 * platform.
 */
function removeDictationPlatformFake(): void {
  Reflect.deleteProperty(navigator, "mediaDevices")
  runningPlatform = undefined
}

/**
 * Replaces, for the running case, the platform a dictation runs on: the
 * `WebSocket`, the microphone of `navigator.mediaDevices`, the
 * `AudioContext`, and the `AudioWorkletNode`.
 *
 * @returns The platform's record. Its microphone opens at once with a new
 * stream and its worklet module loads at once, until the case replaces
 * either answer.
 * @remarks Only platform globals are replaced, so the socket adapter, the
 * recorder, the composer's dictation, and the store under test are the real
 * ones. The navigator keeps everything else it has. Vitest restores the
 * globals after the case, and the microphone is removed when the case
 * finishes. A socket opens only when the case calls
 * {@link FakeWebSocket.open}.
 */
export function startDictationPlatformFake(): DictationPlatformFake {
  const platform: DictationPlatformFake = {
    sockets: [],
    microphoneRequests: [],
    streams: [],
    contexts: [],
    nodes: [],
    openMicrophone: () => Promise.resolve(new FakeMicrophoneStream()),
    loadWorkletModule: () => Promise.resolve()
  }
  runningPlatform = platform
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.stubGlobal("AudioContext", FakeAudioContext)
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode)
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: handleMicrophoneRequest }
  })
  onTestFinished(removeDictationPlatformFake)
  return platform
}

/**
 * Gets the socket a dictation opened.
 *
 * @param platform - The case's platform.
 * @param index - Which socket, counted like `Array.prototype.at`; the last
 * by default.
 * @returns The socket.
 * @throws {Error} When no such socket was opened.
 */
export function getDictationSocket(
  platform: DictationPlatformFake,
  index = -1
): FakeWebSocket {
  const socket = platform.sockets.at(index)
  if (socket === undefined) throw new Error("No dictation socket was opened")
  return socket
}

/**
 * Lists the `stop` messages sent on every socket.
 *
 * @param platform - The case's platform.
 * @returns Each text message equal to `{"type":"stop"}` that was sent.
 */
export function listSentStops(platform: DictationPlatformFake): unknown[] {
  return platform.sockets
    .flatMap((socket) => socket.sent)
    .filter((message) => message === JSON.stringify({ type: "stop" }))
}

/**
 * Lists the microphone streams the code under test released.
 *
 * @param platform - The case's platform.
 * @returns Each stream whose track was stopped.
 */
export function listReleasedMicrophones(
  platform: DictationPlatformFake
): FakeMicrophoneStream[] {
  return platform.streams.filter((stream) => stream.track.isStopped)
}
