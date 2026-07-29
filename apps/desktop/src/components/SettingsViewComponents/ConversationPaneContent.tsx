import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"

export default function ConversationPane() {
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
