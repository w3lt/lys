import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { useSettingsContext } from "./SettingsContext"

/**
 * Presents context-overflow policy and the system prompt editor.
 *
 * @remarks Primary category: composition/view. The required
 * `SettingsContext.Provider` owns the application configuration and receives
 * synchronous patches from the toggle and textarea controls; this component
 * owns no state, effects, persistence, or resources. The context consumer
 * throws when the provider is absent. The trim toggle forwards one patch for a
 * recognized `drop` or `stop` selection and ignores empty or unknown arrays;
 * the system-prompt textarea proposes a patch synchronously on every change.
 * Neither control exposes save or operation completion. The pane renders a
 * vertical choice group and a labelled multiline field.
 *
 * @returns The context policy controls and system prompt field.
 */
export default function ConversationPane() {
  const { state, onConfigChange } = useSettingsContext()

  /**
   * Proposes the selected context trimming policy to the settings owner.
   *
   * @param values - Selection values emitted by the toggle-group primitive.
   * @returns Nothing; recognized selections are forwarded once synchronously,
   * while empty or unknown selections are ignored.
   */
  function changeTrim(values: string[]) {
    const value = values[0]
    if (value === "drop" || value === "stop") {
      onConfigChange({ trim: value })
    }
  }

  return (
    <div className="settings-view__stack">
      <section className="settings-view__field">
        <div className="settings-view__section-heading">
          <div>
            <h2>When the context fills</h2>
            <p>Lys never hides which policy is active.</p>
          </div>
        </div>
        <ToggleGroup
          aria-label="Context trimming behavior"
          className="settings-view__choice-group"
          onValueChange={changeTrim}
          orientation="vertical"
          value={[state.config.trim]}
        >
          <ToggleGroupItem
            aria-label="Drop oldest turns"
            className="settings-view__choice"
            value="drop"
            variant="outline"
          >
            <span>
              <strong>Drop oldest turns</strong>
              <small>Keep the transcript, send only the recent window.</small>
            </span>
          </ToggleGroupItem>
          <ToggleGroupItem
            aria-label="Stop and say so"
            className="settings-view__choice"
            value="stop"
            variant="outline"
          >
            <span>
              <strong>Stop and say so</strong>
              <small>Refuse the next request until context is cleared.</small>
            </span>
          </ToggleGroupItem>
        </ToggleGroup>
      </section>

      <Separator className="settings-view__separator" />

      <section className="settings-view__field">
        <label htmlFor="lys-system-prompt">System prompt</label>
        <Textarea
          aria-label="System prompt"
          className="settings-view__textarea"
          id="lys-system-prompt"
          onChange={(event) =>
            onConfigChange({ systemPrompt: event.currentTarget.value })
          }
          rows={7}
          value={state.config.systemPrompt}
        />
        <p className="settings-view__note">
          This instruction is included before every conversation turn.
        </p>
      </section>
    </div>
  )
}
