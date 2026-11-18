import { SPEECH_CLOSE_SUPERSEDED } from "@lys/protocol"
import type { WebSocket } from "ws"

/**
 * Holds the one speech socket that may speak, so a newer socket retires the
 * older one.
 *
 * @remarks Lys speaks one speech at a time, as voice does: opening a speech
 * or notification socket, for any reply, closes the socket already open with
 * the `superseded` close code. A socket is forgotten when it closes.
 * Concurrency model: single-owner, on the backend's event loop.
 */
export class SpeechSocketRegistry {
  /** The socket that may speak, until it closes or a newer one opens. */
  #current: WebSocket | undefined

  /**
   * Makes a socket the one that may speak, closing the older one.
   *
   * @param socket - Newly opened speech or notification socket.
   */
  public register(socket: WebSocket): void {
    const older = this.#current
    this.#current = socket
    older?.close(SPEECH_CLOSE_SUPERSEDED)
  }

  /**
   * Forgets a socket that closed.
   *
   * @param socket - Socket that closed; a socket already replaced by a newer
   * one is ignored.
   */
  public remove(socket: WebSocket): void {
    if (this.#current === socket) this.#current = undefined
  }
}
