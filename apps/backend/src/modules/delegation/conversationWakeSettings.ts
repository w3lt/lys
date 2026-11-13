import type { TurnSettings } from "../chat/turnStart"

/**
 * What a lookup of a conversation's wake settings answers; `status` selects
 * the variant.
 */
export type WakeSettingsLookup =
  | Readonly<{
      /** Wake settings are remembered for the conversation. */
      status: "found"
      /** Those settings, as they were added. */
      settings: TurnSettings
    }>
  | Readonly<{
      /**
       * None is remembered for the conversation, so a wake-up turn of it has
       * no settings to start with.
       */
      status: "none"
    }>
  | Readonly<{
      /**
       * The wake settings were closed: no wake-up turn may start any more,
       * in any conversation.
       */
      status: "closed"
    }>

/** Whether wake settings are still remembered, and the ones that are. */
type WakeSettingsState =
  | Readonly<{
      /** Settings can be added, removed, and found. */
      status: "open"
      /** Wake settings by conversation identity; owned by this state. */
      wakeSettings: Map<string, TurnSettings>
    }>
  | Readonly<{
      /** Everything was forgotten, and nothing is remembered again. */
      status: "closed"
    }>

/** Lookup of a conversation that has no wake settings. */
const NO_WAKE_SETTINGS: WakeSettingsLookup = Object.freeze({ status: "none" })

/** Lookup of any conversation once the wake settings were closed. */
const CLOSED_WAKE_SETTINGS: WakeSettingsLookup = Object.freeze({
  status: "closed"
})

/**
 * Owns the wake settings of conversations, the settings each conversation's
 * wake-up turns are written with, to tell whether a wake-up turn may start
 * and with which settings, while every lookup after `close` answers
 * `closed`.
 *
 * @remarks The invariant is that a conversation has at most one settings
 * object, the one added last and not removed since, and that nothing is
 * remembered once the instance is closed.
 *
 * Lifetime: a conversation's settings are kept in memory until they are
 * replaced or removed, or the instance is closed. Nothing else forgets
 * them, so whoever adds a conversation's settings removes them once no
 * wake-up turn of the conversation can be due any more. Nothing is stored:
 * a restart forgets them all.
 *
 * Lifecycle: `close` is final. It changes what the instance answers and
 * releases nothing, because the instance holds only memory. A closed
 * instance still accepts every call.
 *
 * Concurrency model: single-owner, on the backend's event loop. Every
 * operation is synchronous.
 */
export default class ConversationWakeSettings {
  /** Authoritative state, replaced only by `close`. */
  #state: WakeSettingsState = { status: "open", wakeSettings: new Map() }

  /**
   * Remembers the settings of a conversation's wake-up turns, replacing
   * earlier ones.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @param settings - Settings its wake-up turns are written with; an
   * immutable value, remembered as given.
   * @remarks Does nothing once the instance is closed.
   */
  public addWakeSettings(conversationId: string, settings: TurnSettings): void {
    if (this.#state.status === "closed") return
    this.#state.wakeSettings.set(conversationId, settings)
  }

  /**
   * Forgets the settings of a conversation's wake-up turns.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @remarks Does nothing for a conversation that has none, and nothing once
   * the instance is closed.
   */
  public removeWakeSettings(conversationId: string): void {
    if (this.#state.status === "closed") return
    this.#state.wakeSettings.delete(conversationId)
  }

  /**
   * Looks up the settings of a conversation's wake-up turns.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @returns A frozen lookup: `found` with the settings added last for the
   * conversation; `none` when it has none; `closed`, whatever the
   * conversation, once the instance is closed.
   */
  public findWakeSettings(conversationId: string): WakeSettingsLookup {
    if (this.#state.status === "closed") return CLOSED_WAKE_SETTINGS
    const settings = this.#state.wakeSettings.get(conversationId)
    if (settings === undefined) return NO_WAKE_SETTINGS
    return Object.freeze({ status: "found", settings })
  }

  /**
   * Forgets everything; every later lookup answers `closed`.
   *
   * @remarks Idempotent and final. It exists because a lookup made after the
   * backend's shutdown began must answer `closed` rather than `none`: that
   * answer is what tells a reply ending during the shutdown to start no
   * wake-up turn. It is a change of state, not the release of a resource.
   */
  public close(): void {
    this.#state = { status: "closed" }
  }
}
