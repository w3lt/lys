import { ChevronDown } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { LOCAL_MODEL_INVENTORY } from "@/lib/models/inventory"
import {
  formatComposerModelRowTag,
  readModelResidencyTone,
  readModelRowTone
} from "@/lib/models/model-residency"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

/** Properties accepted by {@link ComposerModelMenu}. */
export type ComposerModelMenuProps = {
  /** Label naming the resident weights or the current process transition. */
  readonly label: string
  /** Persisted default model identifier, or `null` when none is chosen. */
  readonly selectedModelKey: string | null
  /** Residency of the weights, and which weights the state refers to. */
  readonly modelRuntime: ModelRuntimeState
  /** Invoked with the model identifier the user chose. */
  readonly onSelectModel: (modelKey: string) => void
}

/**
 * Names the weights answering this conversation and switches between them.
 *
 * @remarks Primary category: interactive feature. The parent owns the label,
 * the selection, the residency state, and the selection callback; the menu's
 * open state belongs to the underlying menu adapter, as do keyboard navigation,
 * dismissal, and focus return. Every row states its own condition as text — its
 * `resident`, `loading`, `unloading`, `selected`, or on-disk tag — so no state
 * rests on the indicator tone alone.
 *
 * The adapter's radio check mark is suppressed for this menu: it is drawn over
 * the row's tag, and the row already carries its selection both as that text
 * and as the checked state the radio role exposes.
 *
 * The inventory is the placeholder constant described by
 * {@link LOCAL_MODEL_INVENTORY}.
 *
 * @param props - Trigger label, current selection, residency, and callback.
 * @returns The composer's weights menu.
 */
export default function ComposerModelMenu({
  label,
  selectedModelKey,
  modelRuntime,
  onSelectModel
}: ComposerModelMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="composer__model"
        title="Loaded weights"
        type="button"
      >
        <span
          aria-hidden="true"
          className="composer__model-dot"
          data-tone={readModelResidencyTone(modelRuntime)}
        />
        <span className="composer__model-label">{label}</span>
        <ChevronDown aria-hidden="true" className="composer__caret" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="composer__menu composer__menu--models"
        side="top"
      >
        <DropdownMenuRadioGroup
          onValueChange={onSelectModel}
          value={selectedModelKey ?? ""}
        >
          <DropdownMenuLabel className="composer__menu-eyebrow">
            weights
          </DropdownMenuLabel>

          {LOCAL_MODEL_INVENTORY.map((model) => (
            <DropdownMenuRadioItem
              className="composer__model-option"
              key={model.modelKey}
              value={model.modelKey}
            >
              <span
                aria-hidden="true"
                className="composer__model-dot"
                data-tone={readModelRowTone(modelRuntime, model.modelKey)}
              />
              <span className="composer__model-option-lines">
                <span className="composer__model-option-name">
                  {model.modelKey}
                </span>
                <span className="composer__model-option-detail">
                  {model.detail}
                </span>
              </span>
              <span className="composer__model-option-tag">
                {formatComposerModelRowTag(
                  modelRuntime,
                  model,
                  selectedModelKey
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
