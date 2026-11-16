import { SPEECH_CLOSE_SUPERSEDED } from "@lys/protocol"
import type { WebSocket } from "ws"

/**
 * Tracks the speech sockets open for each reply, so a newer socket for the
 * same reply can retire the older one.
 *
 * @remarks One reply owns at most one socket: opening a speech or
 * notification socket for a reply closes the one already open for it with
 * the `superseded` close code, whichever endpoint opened it. Sockets are
 * forgotten when they close.
 */
export class SpeechSocketRegistry {
  /** Open sockets by reply, in the order they opened. */
  readonly #sockets = new Map<string, Set<WebSocket>>()

  /**
   * Registers a socket for a reply, closing every older socket for it.
   *
   * @param key - Identifies the reply the socket speaks for.
   * @param socket - Socket to register.
   */
  public register(key: string, socket: WebSocket): void {
    const sockets = this.#sockets.get(key) ?? new Set<WebSocket>()
    for (const older of sockets) {
      older.close(SPEECH_CLOSE_SUPERSEDED)
    }
    sockets.clear()
    sockets.add(socket)
    this.#sockets.set(key, sockets)
  }

  /**
   * Forgets a socket that closed.
   *
   * @param key - Identifies the reply the socket spoke for.
   * @param socket - Socket to forget.
   */
  public unregister(key: string, socket: WebSocket): void {
    const sockets = this.#sockets.get(key)
    if (sockets === undefined) return
    sockets.delete(socket)
    if (sockets.size === 0) this.#sockets.delete(key)
  }

  /** Number of sockets tracked for a reply; exposed for tests. */
  public count(key: string): number {
    return this.#sockets.get(key)?.size ?? 0
  }
}
