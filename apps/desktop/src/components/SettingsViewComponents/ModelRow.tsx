import type { ReactElement } from "react"
import { llmTestModelApi } from "@lys/protocol"

import { Button } from "@/components/ui/button"
import type { LocalModelDescriptor } from "@/lib/models/inventory"
import {
  formatModelRowTag,
  readModelRowTone
} from "@/lib/models/model-residency"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

/** Selection contract for one backend model row. */
type ModelChoiceProps = {
  /** Validated backend model with display labels. */
  readonly model: LocalModelDescriptor
  /** Whether the settings owner selected this default. */
  readonly isDefault: boolean
  /** Current request/residency summary used for a transition tag. */
  readonly modelRuntime: ModelRuntimeState
  /** Proposes this key as the default, without loading it. */
  readonly onSelect: (modelKey: string) => void
}

/**
 * Presents the default-selection button and backend model metadata.
 * @param props - Parent-owned model, selection, and selection proposal.
 * @returns The native pressed-state selection control.
 * @remarks Owns no state or effects.
 */
function ModelChoice({
  model,
  isDefault,
  modelRuntime,
  onSelect
}: ModelChoiceProps): ReactElement {
  return (
    <button
      aria-pressed={isDefault}
      className="settings-view__model-choice"
      onClick={() => onSelect(model.modelKey)}
      title="Make this the default"
      type="button"
    >
      <span
        aria-hidden="true"
        className="settings-view__status-dot settings-view__status-dot--small"
        data-tone={readModelRowTone(modelRuntime, model)}
      />
      <span className="settings-view__model-lines">
        <span className="settings-view__model-name">
          {model.modelKey}
          {isDefault ? (
            <span className="settings-view__model-default">default</span>
          ) : null}
        </span>
        <span className="settings-view__model-detail">{model.detail}</span>
      </span>
      <span className="settings-view__model-tag">
        {formatModelRowTag(modelRuntime, model)}
      </span>
    </button>
  )
}

/** Backend actions for one model, with application-owned completion. */
type ModelRowActionsProps = {
  /** Canonical model metadata including observed residency. */
  readonly model: LocalModelDescriptor
  /** Prevents new requests while the backend is stopped or busy. */
  readonly disabled: boolean
  /** Loads the selected key and handles failures in shared state. */
  readonly onLoad: (modelKey: string) => Promise<void>
  /** Unloads the selected key and handles failures in shared state. */
  readonly onUnload: (modelKey: string) => Promise<void>
  /** Queries loaded-state health and handles failures in shared state. */
  readonly onTest: (modelKey: string) => Promise<void>
}

/**
 * Presents model operations supported by the backend.
 * @param props - Model, availability, and store-owned asynchronous callbacks.
 * @returns Named native controls for health and residency.
 * @remarks The store observes all failures;
 * this row does not cancel application work on unmount. Health path eligibility
 * comes from the shared parameter validator rather than a copied length limit.
 */
function ModelRowActions({
  model,
  disabled,
  onLoad,
  onUnload,
  onTest
}: ModelRowActionsProps): ReactElement {
  const canTest = llmTestModelApi.params.safeParse({
    modelId: model.modelKey
  }).success
  return (
    <div className="settings-view__model-actions">
      <Button
        aria-label={`Test ${model.modelKey}`}
        disabled={disabled || !canTest}
        onClick={() => void onTest(model.modelKey)}
        size="sm"
        type="button"
        variant="outline"
        title={
          canTest
            ? "Check whether this model is loaded"
            : "This model key exceeds the health endpoint's limit"
        }
      >
        Test
      </Button>
      <Button
        aria-label={`${model.loaded ? "Unload" : "Load"} ${model.modelKey}`}
        className="settings-view__model-act"
        disabled={disabled}
        onClick={() =>
          void (model.loaded
            ? onUnload(model.modelKey)
            : onLoad(model.modelKey))
        }
        size="sm"
        type="button"
        variant={model.loaded ? "outline" : "default"}
      >
        {model.loaded ? "Unload" : "Load"}
      </Button>
    </div>
  )
}

/** Complete row inputs for default selection and model operations. */
type ModelRowProps = ModelChoiceProps & ModelRowActionsProps

/**
 * Composes one model's selection control and independent backend actions.
 * @param props - Parent-owned inventory entry, state, and callbacks.
 * @returns A semantic model-list entry.
 * @remarks Selection never implies loading.
 */
export default function ModelRow({
  model,
  isDefault,
  modelRuntime,
  onSelect,
  disabled,
  onLoad,
  onUnload,
  onTest
}: ModelRowProps): ReactElement {
  return (
    <li
      className="settings-view__model-row"
      data-selected={isDefault ? "" : undefined}
    >
      <ModelChoice
        model={model}
        isDefault={isDefault}
        modelRuntime={modelRuntime}
        onSelect={onSelect}
      />
      <ModelRowActions
        model={model}
        disabled={disabled}
        onLoad={onLoad}
        onUnload={onUnload}
        onTest={onTest}
      />
    </li>
  )
}
