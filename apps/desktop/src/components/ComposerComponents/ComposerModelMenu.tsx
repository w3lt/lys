import {
  LLM_PROVIDERS,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import type { ReactElement } from "react"
import { useLysStore } from "@/lib/store"
import { ChevronDown } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  buildModelDescriptor,
  type LocalModelDescriptor
} from "@/lib/models/inventory"
import type { ModelAvailability } from "@/lib/models/model-availability"
import {
  formatComposerModelRowTag,
  readModelResidencyTone,
  readModelRowTone
} from "@/lib/models/model-residency"
import type {
  ModelRequestState,
  ProviderModelStates
} from "@/lib/store/model-runtime"

import { formatComposerModelName } from "./composer-presentation"

/** One model the menu offers. */
type ComposerModelChoice = {
  /** The model. */
  readonly reference: LlmModelReference
  /** The model as its provider lists it, with display labels. */
  readonly model: LocalModelDescriptor
  /** Request in flight for the model's provider. */
  readonly request: ModelRequestState
  /** Radio value of the row, unique among the menu's rows. */
  readonly value: string
}

/**
 * Builds the radio value of one model's row.
 *
 * @param reference - Model the row offers.
 * @returns A value unique to the provider and key: a provider name never
 * contains a slash, so the first slash ends it.
 */
function buildModelChoiceValue(reference: LlmModelReference): string {
  return `${reference.provider}/${reference.modelKey}`
}

/**
 * Lists the models the menu offers.
 *
 * @param enabledProviders - Providers the saved settings turn on.
 * @param providerModels - What the desktop knows of every provider.
 * @returns Every model a turned-on provider's read inventory lists, in
 * provider order and then in inventory order.
 */
function listComposerModelChoices(
  enabledProviders: readonly LlmProvider[],
  providerModels: ProviderModelStates
): readonly ComposerModelChoice[] {
  return LLM_PROVIDERS.filter((provider) =>
    enabledProviders.includes(provider)
  ).flatMap((provider) => {
    const { inventory, request } = providerModels[provider]
    if (inventory.status !== "ready") return []
    return inventory.models.map((info) => {
      const reference: LlmModelReference = {
        provider,
        modelKey: info.modelKey
      }
      return {
        reference,
        model: buildModelDescriptor(info),
        request,
        value: buildModelChoiceValue(reference)
      }
    })
  })
}

/** Properties accepted by {@link ComposerModelMenu}. */
export type ComposerModelMenuProps = {
  /** Label naming the model or the current process transition. */
  readonly label: string
  /** The model the next message goes to, or `null` when there is none. */
  readonly selectedModel: LlmModelReference | null
  /** Availability of that model, or `null` when there is none. */
  readonly availability: ModelAvailability | null
  /** Invoked with the model the user chose. */
  readonly onSelectModel: (model: LlmModelReference) => void
}

/**
 * Names the model answering this conversation and switches between models.
 *
 * @remarks The parent owns the label, the selection, its availability, and
 * the selection callback; the menu's open state belongs to the underlying
 * menu adapter, as do keyboard navigation, dismissal, and focus return. Every
 * row names its model with its provider, so the same key on two providers is
 * two rows, and states its own condition as text — its `resident`,
 * `loading`, `unloading`, `selected`, or on-disk tag — so no state rests on
 * the indicator tone alone.
 *
 * The adapter's radio check mark is suppressed for this menu: it is drawn over
 * the row's tag, and the row already carries its selection both as that text
 * and as the checked state the radio role exposes.
 *
 * The application store owns every provider's inventory, shared with
 * settings. The menu lists the models of every turned-on provider whose
 * inventory was read, and each row uses its own loaded observation, so
 * multiple resident models are visible.
 *
 * @param props - Trigger label, current selection, its availability, and
 * callback.
 * @returns The composer's weights menu.
 */
export default function ComposerModelMenu({
  label,
  selectedModel,
  availability,
  onSelectModel
}: ComposerModelMenuProps): ReactElement {
  const enabledProviders = useLysStore(
    (state) => state.settings.providers.enabled
  )
  const providerModels = useLysStore((state) => state.providerModels)
  const choices = listComposerModelChoices(enabledProviders, providerModels)
  const selectedValue =
    selectedModel === null ? "" : buildModelChoiceValue(selectedModel)

  /**
   * Hands the chosen row's model to the parent.
   *
   * @param value - Radio value of the chosen row.
   */
  function handleValueChange(value: string): void {
    const choice = choices.find((candidate) => candidate.value === value)
    if (choice !== undefined) onSelectModel(choice.reference)
  }

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
          data-tone={readModelResidencyTone(availability)}
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
          onValueChange={handleValueChange}
          value={selectedValue}
        >
          <DropdownMenuLabel className="composer__menu-eyebrow">
            weights
          </DropdownMenuLabel>

          {choices.length === 0 ? (
            <DropdownMenuLabel>
              No model inventory · open Model settings
            </DropdownMenuLabel>
          ) : null}
          {choices.map(({ reference, model, request, value }) => (
            <DropdownMenuRadioItem
              className="composer__model-option"
              key={value}
              value={value}
            >
              <span
                aria-hidden="true"
                className="composer__model-dot"
                data-tone={readModelRowTone(request, model)}
              />
              <span className="composer__model-option-lines">
                <span className="composer__model-option-name">
                  {formatComposerModelName(reference)}
                </span>
                <span className="composer__model-option-detail">
                  {model.detail}
                </span>
              </span>
              <span className="composer__model-option-tag">
                {formatComposerModelRowTag(
                  request,
                  model,
                  value === selectedValue
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
