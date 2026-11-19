import type { WebSocket } from "ws"

/**
 * Holds the one socket of a kind that may be open, so a newer socket retires
 * the older one.
 *
 * @remarks Lys speaks one speech and listens to one dictation at a time, as
 * voice does, each under its own registry: opening a socket closes the
 * socket already registered with the registry's `superseded` close code. A
 * socket is forgotten when it closes. Concurrency model: single-owner, on
 * the backend's event loop.
 */
export class SingleSocketRegistry {
  /** Close code the retired socket is closed with. */
  readonly #supersededCloseCode: number
  /** The socket that may be open, until it closes or a newer one opens. */
  #current: WebSocket | undefined

  /**
   * Creates a registry that holds no socket.
   *
   * @param supersededCloseCode - Close code a socket is closed with when a
   * newer one replaces it.
   */
  public constructor(supersededCloseCode: number) {
    this.#supersededCloseCode = supersededCloseCode
  }

  /**
   * Makes a socket the one that may be open, closing the older one.
   *
   * @param socket - Newly opened socket.
   */
  public register(socket: WebSocket): void {
    const older = this.#current
    this.#current = socket
    older?.close(this.#supersededCloseCode)
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
