import type { ReactElement } from "react"
import { Avatar, AvatarImage } from "../ui/avatar"
import lysDarkAvatar from "@/assets/avatars/lys_dark.png"
import lysLightAvatar from "@/assets/avatars/lys_light.png"
import w3ltAvatar from "@/assets/avatars/w3lt.jpg"
import { useTheme } from "@/app/theme"

/** Transcript speaker that an identity mark stands for. */
export type TranscriptSpeaker = "lys" | "you"

/** Properties accepted by {@link SpeakerAvatar}. */
export type SpeakerAvatarProps = {
  /** Speaker whose identity mark is rendered beside the transcript label. */
  readonly speaker: TranscriptSpeaker
}

/*
 * Both marks are the design's own no-portrait state: Lys wears the brand
 * gradient around a dark core, and the person wears the muted identity
 * gradient behind an initial. Rendering a portrait image instead is a change
 * to this one component once real avatar images exist.
 */

/**
 * Initial worn by the person's mark while the application knows no portrait.
 *
 * @remarks Taken from the transcript's own `you` speaker label, which is the
 * only name the application currently holds for the person.
 */
const USER_AVATAR_INITIAL = "Y"

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
  return (
    <span
      aria-hidden="true"
      className={`chat-view__avatar chat-view__avatar--${speaker}`}
    >
      {speaker === "you" ? (
        USER_AVATAR_INITIAL
      ) : (
        <span className="chat-view__avatar-core" />
      )}
    </span>
  )
}

function LysAvatar(): ReactElement {
  const { theme } = useTheme()
  const isDark = theme === "dark"
  return (
    <Avatar>
      <AvatarImage src={isDark ? lysDarkAvatar : lysLightAvatar} />
    </Avatar>
  )
}

function W3ltAvatar(): ReactElement {
  return (
    <Avatar>
      <AvatarImage src={w3ltAvatar} />
    </Avatar>
  )
}
