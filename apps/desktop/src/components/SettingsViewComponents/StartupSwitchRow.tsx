import { useId, type ReactElement } from "react"
import { Switch } from "@/components/ui/switch"

/** Properties accepted by {@link StartupSwitchRow}. */
type StartupSwitchRowProps = {
  /** What the switch starts when Lys opens; the row's heading and the switch's name. */
  readonly label: string
  /** What off means, shown under the heading and given as the switch's description. */
  readonly description: string
  /** Whether the switch is on. */
  readonly isOn: boolean
  /**
   * Proposes a new state for the switch, once per change.
   *
   * @param isOn - Proposed state. The switch shows it only once the parent
   * passes it back as `isOn`.
   */
  readonly onIsOnChange: (isOn: boolean) => void
}

/**
 * Presents one startup switch of the Runtime pane: its heading, what off
 * means, and the switch.
 *
 * @remarks The parent owns the switch's state and decides whether a proposal
 * is accepted; the row owns no state, effect, or store access. The heading
 * and the switch's accessible name are both `label`, and the description is
 * the switch's accessible description. The "on" or "off" beside the switch
 * is hidden from assistive technology, which announces the switch's own
 * checked state. A click and the keyboard both propose a change.
 * @param props - Parent-owned label, description, state, and proposal.
 * @returns The switch's card row.
 */
export default function StartupSwitchRow({
  label,
  description,
  isOn,
  onIsOnChange
}: StartupSwitchRowProps): ReactElement {
  const descriptionId = useId()

  return (
    <div className="settings-view__card-row">
      <div className="settings-view__identity-lines">
        <h2>{label}</h2>
        <p id={descriptionId}>{description}</p>
      </div>
      <div className="settings-view__toggle-state">
        {/* The switch already announces its state; this is for the eye. */}
        <span aria-hidden="true">{isOn ? "on" : "off"}</span>
        <Switch
          aria-describedby={descriptionId}
          aria-label={label}
          checked={isOn}
          onCheckedChange={(proposedIsOn) => {
            onIsOnChange(proposedIsOn)
          }}
          size="lg"
        />
      </div>
    </div>
  )
}
