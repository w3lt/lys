import type { ReactElement } from "react"

import lysDarkAvatar from "@/assets/avatars/lys_dark.png"
import lysLightAvatar from "@/assets/avatars/lys_light.png"
import w3ltAvatar from "@/assets/avatars/w3lt.jpg"
import { Avatar, AvatarImage } from "@/components/ui/avatar"

/** Transcript speaker that an identity mark stands for. */
export type TranscriptSpeaker = "lys" | "you"

/** Properties accepted by {@link SpeakerAvatar}. */
export type SpeakerAvatarProps = {
  /** Speaker whose identity mark is rendered beside the transcript label. */
  readonly speaker: TranscriptSpeaker
}

/**
 * Presents the circular identity mark of one transcript speaker.
 *
 * @remarks Primary category: presentational. The parent owns the speaker and
 * places the mark immediately before the visible speaker label. The mark only
 * repeats that label, so it is excluded from the accessibility tree and never
 * carries a speaker's only cue.
 * @param props - Transcript speaker selected by the surrounding message.
 * @returns The rendered identity mark for that speaker.
 */
export default function SpeakerAvatar({
  speaker
}: SpeakerAvatarProps): ReactElement {
  switch (speaker) {
    case "lys":
      return <LysAvatar />
    case "you":
      return <W3ltAvatar />
  }
}

/**
 * Presents Lys's theme-matched transcript portrait.
 *
 * @remarks Primary category: presentational. The application's root theme
 * class selects one of the decorative portraits without component-owned state.
 * @returns The light and dark portrait alternatives for Lys.
 */
function LysAvatar(): ReactElement {
  return (
    <>
      <Avatar aria-hidden="true" className="size-7 dark:hidden">
        <AvatarImage alt="" src={lysLightAvatar} />
      </Avatar>
      <Avatar aria-hidden="true" className="hidden size-7 dark:flex">
        <AvatarImage alt="" src={lysDarkAvatar} />
      </Avatar>
    </>
  )
}

/**
 * Presents the person's transcript portrait.
 *
 * @remarks Primary category: presentational. The portrait is decorative
 * because the adjacent transcript label already identifies the speaker.
 * @returns The person's portrait.
 */
function W3ltAvatar(): ReactElement {
  return (
    <Avatar aria-hidden="true" className="size-7">
      <AvatarImage alt="" src={w3ltAvatar} />
    </Avatar>
  )
}
