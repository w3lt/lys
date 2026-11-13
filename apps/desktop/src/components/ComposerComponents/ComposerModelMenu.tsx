import {
  LLM_PROVIDER_NAMES,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import type { ReactElement } from "react"
import { ChevronDown } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import type { ModelAvailability } from "@/lib/models/model-availability"
import {
  formatComposerModelRowTag,
  readModelResidencyTone,
  readModelRowTone
} from "@/lib/models/model-residency"
import { formatModelReferenceLabel } from "@/lib/models/provider-connection"

import type {
  ComposerModelChoice,
  ComposerModelGroup
} from "./composer-presentation"
import { buildComposerModelChoiceValue } from "./composer-presentation"

/** Properties accepted by {@link ComposerModelChoices}. */
type ComposerModelChoicesProps = {
  /** Provider the group is labelled with. */
  readonly provider: LlmProvider
  /** Its models, in inventory order. */
  readonly choices: readonly ComposerModelChoice[]
  /** Radio value of the conversation's model, or empty when there is none. */
  readonly selectedValue: string
  /**
   * Hands the chosen row's radio value to the menu.
   *
   * @param value - Radio value of the chosen row.
   */
  readonly onSelectedValueChange: (value: string) => void
}

/** Properties accepted by {@link ComposerProviderStatus}. */
type ComposerProviderStatusProps = {
  /** Provider the group is labelled with. */
  readonly provider: LlmProvider
  /** Why the provider lists no model now. */
  readonly status: string
}

/** Properties accepted by {@link ComposerNoProvider}. */
type ComposerNoProviderProps = {
  /** Requests that the parent show the Providers pane. */
  readonly onOpenProviders: () => void
}

/** Properties accepted by {@link ComposerModelMenu}. */
export type ComposerModelMenuProps = {
  /** Label naming the model or the current process transition. */
  readonly label: string
  /** The model the next message goes to, or `null` when there is none. */
  readonly selectedModel: LlmModelReference | null
  /** Availability of that model, or `null` when there is none. */
  readonly availability: ModelAvailability | null
  /** One group per turned-on provider, in provider order. */
  readonly groups: readonly ComposerModelGroup[]
  /** Whether the menu is open; the parent owns it. */
  readonly isOpen: boolean
  /**
   * Proposes opening or closing the menu, once per change.
   *
   * @param isOpen - Proposed state, shown once the parent passes it back.
   */
  readonly onIsOpenChange: (isOpen: boolean) => void
  /** Invoked with the model the user chose. */
  readonly onSelectModel: (model: LlmModelReference) => void
  /** Requests that the parent show the Providers pane. */
  readonly onOpenProviders: () => void
}

/**
 * Presents one connected provider's models as a labelled radio group.
 *
 * @remarks A pure projection of its props. Every row names its model with
 * its provider and states its own condition as text, so no state rests on
 * the indicator tone alone. The rows share the menu's selected value, so at
 * most one row of the whole menu is checked.
 * @param props - Provider, its models, the selected value, and the choice
 * callback.
 * @returns The provider's group.
 */
function ComposerModelChoices({
  provider,
  choices,
  selectedValue,
  onSelectedValueChange
}: ComposerModelChoicesProps): ReactElement {
  return (
    <DropdownMenuRadioGroup
      className="composer__model-group"
      onValueChange={onSelectedValueChange}
      value={selectedValue}
    >
      <DropdownMenuLabel className="composer__menu-eyebrow">
        {LLM_PROVIDER_NAMES[provider]}
      </DropdownMenuLabel>
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
              {formatModelReferenceLabel(reference)}
            </span>
            <span className="composer__model-option-detail">
              {model.detail}
            </span>
          </span>
          <span className="composer__model-option-tag">
            {formatComposerModelRowTag(request, model, value === selectedValue)}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/**
 * Presents a turned-on provider that lists no model now: its label and a
 * disabled line saying why.
 *
 * @remarks A pure projection of its props. The line is a disabled item, so
 * the menu's keyboard and screen reader users meet it among the models.
 * @param props - Provider and why it lists no model.
 * @returns The provider's group.
 */
function ComposerProviderStatus({
  provider,
  status
}: ComposerProviderStatusProps): ReactElement {
  return (
    <DropdownMenuGroup className="composer__model-group">
      <DropdownMenuLabel className="composer__menu-eyebrow">
        {LLM_PROVIDER_NAMES[provider]}
      </DropdownMenuLabel>
      <DropdownMenuItem className="composer__model-status" disabled>
        {status}
      </DropdownMenuItem>
    </DropdownMenuGroup>
  )
}

/**
 * Presents the menu's content while no provider is on: that none is, and an
 * item that opens Providers.
 *
 * @remarks Choosing Open Providers closes the menu and asks the parent to
 * show the Providers pane.
 * @param props - The request to open Providers.
 * @returns The group.
 */
function ComposerNoProvider({
  onOpenProviders
}: ComposerNoProviderProps): ReactElement {
  return (
    <DropdownMenuGroup className="composer__model-group">
      <DropdownMenuLabel className="composer__menu-eyebrow">
        No provider is on
      </DropdownMenuLabel>
      <DropdownMenuItem
        className="composer__model-status"
        onClick={onOpenProviders}
      >
        Open Providers
      </DropdownMenuItem>
    </DropdownMenuGroup>
  )
}

/**
 * Names the model answering this conversation and switches between the
 * models of every turned-on provider.
 *
 * @remarks The parent owns the label, the selection, its availability, the
 * groups, whether the menu is open, and the callbacks; the menu adapter owns
 * keyboard navigation, dismissal, and focus return. The menu shows one
 * labelled group per turned-on provider in provider order: a connected
 * provider's models, or a line saying why the provider lists none, so each
 * provider's list appears as it arrives. The same key on two providers is two
 * rows. While no provider is on, the menu says so and offers to open
 * Providers.
 *
 * The adapter's radio check mark is suppressed for this menu: it is drawn over
 * the row's tag, and the row already carries its selection both as that text
 * and as the checked state the radio role exposes.
 *
 * @param props - Trigger label, current selection, its availability, the
 * groups, the open state, and callbacks.
 * @returns The composer's model menu.
 */
export default function ComposerModelMenu({
  label,
  selectedModel,
  availability,
  groups,
  isOpen,
  onIsOpenChange,
  onSelectModel,
  onOpenProviders
}: ComposerModelMenuProps): ReactElement {
  const selectedValue =
    selectedModel === null ? "" : buildComposerModelChoiceValue(selectedModel)
  const choices = groups.flatMap((group) =>
    group.kind === "models" ? group.choices : []
  )

  /**
   * Hands the chosen row's model to the parent.
   *
   * @param value - Radio value of the chosen row.
   */
  function handleSelectedValueChange(value: string): void {
    const choice = choices.find((candidate) => candidate.value === value)
    if (choice !== undefined) onSelectModel(choice.reference)
  }

  return (
    <DropdownMenu
      onOpenChange={(proposedIsOpen) => {
        onIsOpenChange(proposedIsOpen)
      }}
      open={isOpen}
    >
      <DropdownMenuTrigger
        className="composer__model"
        title="Model"
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
        {groups.length === 0 ? (
          <ComposerNoProvider onOpenProviders={onOpenProviders} />
        ) : null}
        {groups.map((group) =>
          group.kind === "models" ? (
            <ComposerModelChoices
              choices={group.choices}
              key={group.provider}
              onSelectedValueChange={handleSelectedValueChange}
              provider={group.provider}
              selectedValue={selectedValue}
            />
          ) : (
            <ComposerProviderStatus
              key={group.provider}
              provider={group.provider}
              status={group.status}
            />
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
