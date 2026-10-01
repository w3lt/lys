import type { ReactElement } from "react"

import { STARTER_PROMPTS } from "@/app/content"
import lysDarkPortrait from "@/assets/avatars/lys_dark.png"
import lysLightPortrait from "@/assets/avatars/lys_light.png"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

/**
 * Outline of Lys's right wing in emblem coordinates, whose origin is the
 * portrait's center: a forewing rising above the body line and a hindwing
 * hanging below it. The left wing mirrors the same geometry.
 */
const WING_MEMBRANE_PATH =
  "M0 -4 L64 -56 L148 -72 L176 -38 L124 -6 Z " +
  "M0 4 L122 6 L150 40 L106 70 L44 52 Z"

/** Veins joining each wing panel's corners to that panel's inner node. */
const WING_VEIN_PATH =
  "M0 -4 L100 -36 L64 -56 M148 -72 L100 -36 L176 -38 M124 -6 L100 -36 " +
  "M0 4 L94 34 L122 6 M150 40 L94 34 L106 70 M44 52 L94 34"

/**
 * Constellation points at the wing corners and vein nodes, plus three free
 * stars. Each is a zero-length segment that a round line cap draws as a dot.
 */
const WING_STAR_PATH =
  "M64 -56h0 M148 -72h0 M176 -38h0 M124 -6h0 M100 -36h0 " +
  "M122 6h0 M150 40h0 M106 70h0 M44 52h0 M94 34h0 " +
  "M34 -74h0 M190 -64h0 M178 66h0"

/** Properties accepted by {@link EmblemWing}. */
type EmblemWingProps = {
  /** Side of the portrait the wing spreads toward; left is violet, right cyan. */
  readonly side: "left" | "right"
}

/** Properties accepted by {@link StarterView}. */
type StarterViewProps = {
  /** Requests that the parent send the clicked starter prompt as a message. */
  readonly onSendStarterPrompt: (prompt: string) => void
}

/**
 * Presents one constellation wing of the starter emblem.
 *
 * @remarks The wing renders inside the
 * emblem's decorative SVG and owns no state, effects, or semantics. Its side
 * selects the tint and mirroring, matching the portrait's violet left eye and
 * cyan right eye.
 * @param props - Side of the portrait the wing spreads toward.
 * @returns The wing's membrane, veins, and constellation points.
 */
function EmblemWing({ side }: EmblemWingProps): ReactElement {
  return (
    <g className={`chat-view__wing chat-view__wing--${side}`}>
      <path
        className="chat-view__wing-membrane"
        d={WING_MEMBRANE_PATH}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="chat-view__wing-veins"
        d={WING_VEIN_PATH}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="chat-view__wing-stars"
        d={WING_STAR_PATH}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}

/**
 * Presents Lys's portrait between two constellation wings.
 *
 * @remarks The emblem repeats the adjacent
 * "Lys" heading, so it is hidden from assistive technology and contains no
 * focusable content. The application's root theme class selects the light or
 * dark portrait. The component owns no state, effects, or resources.
 * @returns The decorative winged portrait.
 */
function StarterEmblem(): ReactElement {
  return (
    <div aria-hidden="true" className="chat-view__emblem">
      <svg
        className="chat-view__wings"
        focusable="false"
        viewBox="-200 -80 400 160"
      >
        <EmblemWing side="left" />
        <EmblemWing side="right" />
      </svg>
      <div className="chat-view__portrait">
        <img
          alt=""
          className="chat-view__portrait-image dark:hidden"
          src={lysLightPortrait}
        />
        <img
          alt=""
          className="chat-view__portrait-image hidden dark:block"
          src={lysDarkPortrait}
        />
      </div>
    </div>
  )
}

/**
 * Presents the empty-session introduction and its starter prompts.
 *
 * @remarks The parent owns prompt
 * submission and request lifecycle; this component owns no state, effects, or
 * resources. Each prompt is rendered as an accessible button in source order,
 * and `onSendStarterPrompt` fires once per click with that button's prompt.
 * The winged portrait and the gem divider are decorative and hidden from
 * assistive technology. The view plays one entrance sequence when it mounts;
 * a reduced-motion preference removes it.
 * @param props - Parent callback receiving the selected prompt text.
 * @returns The empty-session emblem, heading, explanation, and starter controls.
 */
export default function StarterView({
  onSendStarterPrompt
}: StarterViewProps): ReactElement {
  return (
    <div className="chat-view__empty">
      <StarterEmblem />
      <h1>Lys</h1>
      <p className="chat-view__eyebrow">Lysiptera Caliginia</p>
      <span aria-hidden="true" className="chat-view__gem" />
      <p className="chat-view__subtitle">
        One model, one conversation at a time. The transcripts stay on this
        machine.
      </p>
      <div className="chat-view__starters" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <Button
            className="chat-view__starter lys-wingline"
            data-lys-wingline="primary"
            key={prompt}
            onClick={() => onSendStarterPrompt(prompt)}
            size="lg"
            type="button"
            variant="outline"
          >
            <span>{prompt}</span>
            <ArrowRight aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  )
}
