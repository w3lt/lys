import { useId, type ReactElement } from "react"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { ChevronDown, Cloud, Monitor, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

import {
  formatModelPlacementName,
  listModelProviderGroups,
  type ModelPlacement,
  type ModelProviderGroup,
  type ModelProviderSummary
} from "./model-pane-presentation"

/** Properties accepted by {@link PlacementIcon}. */
type PlacementIconProps = {
  /** Where the provider runs models. */
  readonly placement: ModelPlacement
}

/**
 * Draws a cloud for a cloud provider and a screen for this machine.
 *
 * @remarks Presentational and hidden from assistive technology; the words
 * beside it say the same.
 * @param props - Where the provider runs models.
 * @returns The icon.
 */
function PlacementIcon({ placement }: PlacementIconProps): ReactElement {
  return placement === "cloud" ? (
    <Cloud aria-hidden="true" className="settings-view__models-icon" />
  ) : (
    <Monitor aria-hidden="true" className="settings-view__models-icon" />
  )
}

/**
 * Formats the status line of a provider.
 *
 * @param summary - The provider's summary.
 * @returns Its status, then its model count when one is known.
 */
function formatProviderStatusLine(summary: ModelProviderSummary): string {
  return summary.count === null
    ? summary.status
    : `${summary.status} · ${summary.count}`
}

/** Properties accepted by {@link ProviderChoice}. */
type ProviderChoiceProps = {
  /** Summary of the provider the item chooses. */
  readonly summary: ModelProviderSummary
}

/**
 * Presents one provider in the picker as a radio item.
 *
 * @remarks Presentational. Shows the provider's name, its status beside a
 * toned dot, its model count, where Lys reaches it, and the session's
 * default model when it is the provider's; the radio item marks the shown
 * provider with a check.
 * @param props - The provider's summary.
 * @returns The radio item.
 */
function ProviderChoice({ summary }: ProviderChoiceProps): ReactElement {
  const detail =
    summary.defaultModelKey === null
      ? summary.location
      : `${summary.location} · default ${summary.defaultModelKey}`
  return (
    <DropdownMenuRadioItem
      className="settings-view__models-choice"
      value={summary.provider}
    >
      <PlacementIcon placement={summary.placement} />
      <span className="settings-view__models-choice-lines">
        <span className="settings-view__models-choice-name">
          {summary.name}
        </span>
        <span className="settings-view__models-choice-status">
          <span
            aria-hidden="true"
            className="settings-view__status-dot settings-view__status-dot--small"
            data-tone={summary.tone}
          />
          {formatProviderStatusLine(summary)}
        </span>
        <span className="settings-view__models-mono">{detail}</span>
      </span>
    </DropdownMenuRadioItem>
  )
}

/** Properties accepted by {@link ProviderChoiceGroup}. */
type ProviderChoiceGroupProps = {
  /** Providers that run their models in one place. */
  readonly group: ModelProviderGroup
  /** Whether the group opens the menu, so no separator precedes it. */
  readonly isFirst: boolean
}

/**
 * Presents one group of the picker's providers under its heading.
 *
 * @remarks Presentational. A separator precedes every group but the first;
 * the heading labels the group's items.
 * @param props - The group and whether it is the first.
 * @returns The separator, when one is needed, and the labelled group.
 */
function ProviderChoiceGroup({
  group,
  isFirst
}: ProviderChoiceGroupProps): ReactElement {
  return (
    <>
      {isFirst ? null : <DropdownMenuSeparator />}
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {formatModelPlacementName(group.placement)}
        </DropdownMenuLabel>
        {group.summaries.map((summary) => (
          <ProviderChoice key={summary.provider} summary={summary} />
        ))}
      </DropdownMenuGroup>
    </>
  )
}

/** Properties accepted by {@link ModelProviderCard}. */
export type ModelProviderCardProps = {
  /** Summary of the provider the pane shows. */
  readonly shown: ModelProviderSummary
  /** Summaries of every provider that is on, in provider order. */
  readonly choices: readonly ModelProviderSummary[]
  /** What the shown provider does with its models. */
  readonly note: string
  /** When the provider was last read, or what a refresh is doing. */
  readonly refreshNote: string
  /** Whether a refresh of the shown provider is in flight. */
  readonly isRefreshing: boolean
  /** Whether Refresh is disabled, because a request runs or none can start. */
  readonly isRefreshDisabled: boolean
  /**
   * Proposes another provider for the pane to show, called once per
   * choice of a provider other than the shown one.
   *
   * @param provider - The chosen provider.
   */
  readonly onShownProviderChange: (provider: LlmProvider) => void
  /** Requests that the shown provider be read again; once per press. */
  readonly onRefreshProvider: () => void
}

/**
 * Lets the person choose which provider's models the Model pane shows, and
 * shows that provider's status with a way to read it again.
 *
 * @remarks Interactive feature: the menu owns only its open state; the
 * parent owns the shown provider. The picker lists the providers that are
 * on, cloud ones first, as radio items. Base UI supplies the menu's
 * keyboard and focus behavior. The status is a word beside a toned dot,
 * the refresh note is a status region, and Refresh reads Refreshing… while
 * its request runs.
 * @param props - Shown provider, choices, note, refresh state, and the two
 * requests.
 * @returns The provider card.
 */
export default function ModelProviderCard({
  shown,
  choices,
  note,
  refreshNote,
  isRefreshing,
  isRefreshDisabled,
  onShownProviderChange,
  onRefreshProvider
}: ModelProviderCardProps): ReactElement {
  const headingId = useId()

  /**
   * Proposes the chosen provider when it is another one.
   *
   * @param value - Radio value of the chosen item.
   */
  function handleProviderValueChange(value: string): void {
    const provider = LLM_PROVIDERS.find((candidate) => candidate === value)
    if (provider !== undefined && provider !== shown.provider) {
      onShownProviderChange(provider)
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="settings-view__models-provider"
    >
      <div className="settings-view__models-provider-main">
        <h2 className="settings-view__models-eyebrow" id={headingId}>
          Provider
        </h2>
        <div className="settings-view__models-provider-line">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="settings-view__models-picker"
              type="button"
            >
              <PlacementIcon placement={shown.placement} />
              <span className="settings-view__models-picker-name">
                {shown.name}
              </span>
              <span className="settings-view__models-picker-where">
                {formatModelPlacementName(shown.placement)}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="settings-view__models-icon"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="settings-view__models-menu"
            >
              <DropdownMenuRadioGroup
                onValueChange={handleProviderValueChange}
                value={shown.provider}
              >
                {listModelProviderGroups(choices).map((group, index) => (
                  <ProviderChoiceGroup
                    group={group}
                    isFirst={index === 0}
                    key={group.placement}
                  />
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="settings-view__models-provider-status">
            <span
              aria-hidden="true"
              className="settings-view__status-dot"
              data-tone={shown.tone}
            />
            <span>{formatProviderStatusLine(shown)}</span>
            <span className="settings-view__models-mono">{`· ${shown.location}`}</span>
          </p>
        </div>
        <p className="settings-view__models-note">{note}</p>
      </div>
      <div className="settings-view__models-refresh">
        <span className="settings-view__models-note" role="status">
          {refreshNote}
        </span>
        <Button
          disabled={isRefreshDisabled}
          onClick={onRefreshProvider}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" />
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </section>
  )
}
