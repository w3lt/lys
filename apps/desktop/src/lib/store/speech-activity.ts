import { create, type StoreApi, type UseBoundStore } from "zustand"

/** Whether Lys is talking, as the speech wiring last reported it. */
export type SpeechActivityState = Readonly<{
  /**
   * Whether Lys is talking: a speech or notification socket is open, or
   * audio of one is still playing.
   */
  isTalking: boolean
}>

/**
 * Whether Lys is talking, for whatever must not run while she does, such as
 * a dictation.
 *
 * @remarks The speech wiring owns the value and writes it with `setState`;
 * everything else only reads it. It is false while speech is not started.
 */
export const useSpeechActivityStore: UseBoundStore<
  StoreApi<SpeechActivityState>
> = create<SpeechActivityState>(() => ({ isTalking: false }))
