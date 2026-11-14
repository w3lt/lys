import { useId, useState, type ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"
import type { LlmProvider } from "@lys/share"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatTokenCount } from "@/lib/models/model-load-configuration"

import ModelRow, { type ModelListEntry } from "./ModelRow"
import {
  describeModelPaneProvider,
  formatModelFilterResult,
  formatModelListHeading,
  formatModelSize,
  listMatchingModels
} from "./model-pane-presentation"

/** One labelled run of rows in the model list. */
type ModelRowGroup = {
  /** Group heading, or null for a list shown as one run. */
  readonly label: string | null
  /** Whether the heading carries the loaded dot. */
  readonly isLoaded: boolean
  /** The group's rows, in inventory order. */
  readonly entries: readonly ModelListEntry[]
}

/** Keys of the models the list marks as selected, default, and loading. */
type ModelListMarks = Pick<
  ModelListProps,
  "selectedModelKey" | "defaultModelKey" | "loadingModelKey"
>

/**
 * Formats the value of the list's right column for one model.
 *
 * @param provider - Provider whose models are listed.
 * @param model - Model of the row.
 * @returns Groq's context length, abbreviated, or the model's size on disk,
 * or a dash when the provider reports none.
 */
function formatModelColumnValue(provider: LlmProvider, model: LlmInfo): string {
  if (provider === "groq") return formatTokenCount(model.maxContextLength)
  return model.sizeBytes === undefined ? "—" : formatModelSize(model.sizeBytes)
}

/**
 * Builds the row of one model.
 *
 * @param provider - Provider whose models are listed.
 * @param model - Model of the row.
 * @param marks - Keys of the selected, default, and loading models.
 * @returns The model with its column value and whether each mark is its.
 */
function buildModelListEntry(
  provider: LlmProvider,
  model: LlmInfo,
  marks: ModelListMarks
): ModelListEntry {
  return {
    model,
    columnValue: formatModelColumnValue(provider, model),
    isSelected: model.modelKey === marks.selectedModelKey,
    isDefault: model.modelKey === marks.defaultModelKey,
    isLoading: model.modelKey === marks.loadingModelKey
  }
}

/**
 * Groups the shown models' rows as the list presents them.
 *
 * @param provider - Provider whose models are listed.
 * @param models - Models the filter leaves.
 * @param marks - Keys of the selected, default, and loading models.
 * @returns For a provider on this machine, the loaded models and the ones
 * only on disk, each with its count and without an empty group; for a cloud
 * provider, one unlabelled run.
 */
function listModelRowGroups(
  provider: LlmProvider,
  models: readonly LlmInfo[],
  marks: ModelListMarks
): readonly ModelRowGroup[] {
  const entries = models.map((model) =>
    buildModelListEntry(provider, model, marks)
  )
  if (describeModelPaneProvider(provider).placement === "cloud") {
    return [{ label: null, isLoaded: false, entries }]
  }
  const loaded = entries.filter((entry) => entry.model.loaded)
  const onDisk = entries.filter((entry) => !entry.model.loaded)
  return [
    { label: `Loaded · ${loaded.length}`, isLoaded: true, entries: loaded },
    { label: `On disk · ${onDisk.length}`, isLoaded: false, entries: onDisk }
  ].filter((group) => group.entries.length > 0)
}

/** Properties accepted by {@link ModelGroup}. */
type ModelGroupProps = {
  /** The group to present. */
  readonly group: ModelRowGroup
  /**
   * Requests that the Models pane show a model, called once per row press.
   *
   * @param modelKey - Key of the pressed row's model.
   */
  readonly onSelectModel: (modelKey: string) => void
}

/**
 * Presents one run of the model list's rows under its heading.
 *
 * @remarks The heading of the loaded models carries the
 * loaded dot beside its words; the rows form a list named by the heading,
 * or by "Models" for an unlabelled run.
 * @param props - The group and the selection request.
 * @returns The heading, when the group has one, and its rows.
 */
function ModelGroup({ group, onSelectModel }: ModelGroupProps): ReactElement {
  return (
    <div>
      {group.label === null ? null : (
        <p className="settings-view__models-group">
          {group.isLoaded ? (
            <span
              aria-hidden="true"
              className="settings-view__status-dot settings-view__status-dot--small"
              data-tone="active"
            />
          ) : null}
          {group.label}
        </p>
      )}
      <ul aria-label={group.label ?? "Models"}>
        {group.entries.map((entry) => (
          <ModelRow
            entry={entry}
            key={entry.model.modelKey}
            onSelectModel={onSelectModel}
          />
        ))}
      </ul>
    </div>
  )
}

/** Properties accepted by {@link ModelList}. */
export type ModelListProps = {
  /** Provider whose models are listed. */
  readonly provider: LlmProvider
  /** Models the provider's inventory lists, in its order; at least one. */
  readonly models: readonly LlmInfo[]
  /** Key of the model whose details are shown, or null. */
  readonly selectedModelKey: string | null
  /** Key of the session's default model when it is this provider's, or null. */
  readonly defaultModelKey: string | null
  /** Key of the model being loaded, or null. */
  readonly loadingModelKey: string | null
  /**
   * Requests that the Models pane show a model, called once per row press.
   *
   * @param modelKey - Key of the pressed row's model.
   */
  readonly onSelectModel: (modelKey: string) => void
}

/**
 * Filters a provider's models by name and lets the person pick one.
 *
 * @remarks Owns the filter text, which the parent
 * resets by remounting it for another provider. The heading counts the
 * models, or how many of them the filter shows; the right column's name is
 * hidden from assistive technology, since each row ends with its value. A
 * visually hidden status region, rendered from the start, repeats the
 * count, or says that nothing matches, so each change of the filter's
 * result is announced. A provider on this machine groups its rows into
 * loaded models and models on disk. A filter that leaves nothing says so
 * and offers to clear it.
 * @param props - Provider, models, the selected, default, and loading
 * models, and the selection request.
 * @returns The list section: its filter box, heading, result status, and
 * rows.
 */
export default function ModelList({
  provider,
  models,
  selectedModelKey,
  defaultModelKey,
  loadingModelKey,
  onSelectModel
}: ModelListProps): ReactElement {
  const marks = { selectedModelKey, defaultModelKey, loadingModelKey }
  const headingId = useId()
  const filterId = useId()
  const [query, setQuery] = useState("")
  const matches = listMatchingModels(models, query)
  return (
    <section aria-labelledby={headingId} className="settings-view__models-list">
      <div className="settings-view__models-list-top">
        <div className="settings-view__models-filter">
          <label className="sr-only" htmlFor={filterId}>
            Filter models
          </label>
          <Search aria-hidden="true" />
          <Input
            autoComplete="off"
            id={filterId}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name"
            type="search"
            value={query}
          />
        </div>
        <p aria-label="Filter results" className="sr-only" role="status">
          {formatModelFilterResult(matches.length, models.length, query)}
        </p>
        <div className="settings-view__models-list-heading">
          <h3 id={headingId}>
            {formatModelListHeading(matches.length, models.length)}
          </h3>
          <span aria-hidden="true">
            {provider === "groq" ? "Context" : "Size"}
          </span>
        </div>
      </div>
      <div className="settings-view__models-scroll">
        {matches.length === 0 ? (
          <div className="settings-view__models-no-match">
            <p>{`No model matches “${query}”.`}</p>
            <Button
              onClick={() => setQuery("")}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear filter
            </Button>
          </div>
        ) : (
          listModelRowGroups(provider, matches, marks).map((group) => (
            <ModelGroup
              group={group}
              key={group.label ?? "all"}
              onSelectModel={onSelectModel}
            />
          ))
        )}
      </div>
    </section>
  )
}
