import { useId, type ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"
import {
  isSameLlmModelReference,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"

import { useLysStore } from "@/lib/store"

import ModelDefaultAction from "./ModelDefaultAction"
import ModelLoadConfigurationPanel from "./ModelLoadConfigurationPanel"
import ModelStatusPanel from "./ModelStatusPanel"
import {
  findListedModel,
  findModelDefaultChoice,
  isModelDefaultActionDisabled,
  listModelFacts,
  splitModelKey,
  type ModelFact
} from "./model-pane-presentation"
import { useSettingsContext } from "./SettingsContext"

/**
 * Answers whether the session's default is a given model, or none.
 *
 * @param defaultModel - The session's default, or null for none.
 * @param model - Model to compare it with, or null for none.
 * @returns True when both are null or both name the same model.
 */
function isSameDefaultModel(
  defaultModel: LlmModelReference | null,
  model: LlmModelReference | null
): boolean {
  if (defaultModel === null || model === null) return defaultModel === model
  return isSameLlmModelReference(defaultModel, model)
}

/**
 * Makes a model the session's default after its load, unless the default
 * changed since the load was asked for.
 *
 * @param reference - The loaded model.
 * @param pressedDefault - The session's default when Load and set as default
 * was pressed, or null when there was none.
 * @remarks Reads the application store after the load settled, so the
 * settings and inventory are the current ones rather than those of the
 * render that started the load. The default is left as it is when it is no
 * longer the one seen at the press, since a newer choice wins over a late
 * load, and when the inventory does not list the model as loaded, as after
 * a failed load.
 */
function updateDefaultModelAfterLoad(
  reference: LlmModelReference,
  pressedDefault: LlmModelReference | null
): void {
  const state = useLysStore.getState()
  const { runtime } = state.settings
  if (!isSameDefaultModel(runtime.defaultModel, pressedDefault)) return
  const { inventory } = state.providerModels[reference.provider]
  if (findListedModel(inventory, reference.modelKey)?.loaded !== true) return
  state.setSettings({
    ...state.settings,
    runtime: { ...runtime, defaultModel: reference }
  })
}

/** Properties accepted by {@link ModelDetailsHeading}. */
type ModelDetailsHeadingProps = {
  /** Identifier given to the heading, so the details are named by it. */
  readonly headingId: string
  /** Key of the selected model. */
  readonly modelKey: string
  /** Whether the model is the session's default. */
  readonly isDefault: boolean
}

/**
 * Names the selected model at the top of its details.
 *
 * @remarks The key's namespace is quieter than the rest of
 * it, and the default is marked in words beside it.
 * @param props - The heading's identifier, the key, and whether the model
 * is the default.
 * @returns The eyebrow, the model's heading, and the default chip.
 */
function ModelDetailsHeading({
  headingId,
  modelKey,
  isDefault
}: ModelDetailsHeadingProps): ReactElement {
  const { prefix, base, tag } = splitModelKey(modelKey)
  return (
    <div className="settings-view__models-details-heading">
      <p className="settings-view__models-eyebrow">Selected model</p>
      <div>
        <h3 id={headingId}>
          <span>{prefix}</span>
          {`${base}${tag}`}
        </h3>
        {isDefault ? (
          <span className="settings-view__models-chip">Default</span>
        ) : null}
      </div>
    </div>
  )
}

/** Properties accepted by {@link ModelFactList}. */
type ModelFactListProps = {
  /** Facts of the selected model, in the order they are shown. */
  readonly facts: readonly ModelFact[]
}

/**
 * Lists the selected model's facts under its status.
 *
 * @remarks Each fact is a term and its value.
 * @param props - The facts.
 * @returns The description list.
 */
function ModelFactList({ facts }: ModelFactListProps): ReactElement {
  return (
    <dl className="settings-view__models-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Properties accepted by {@link ModelDetails}. */
export type ModelDetailsProps = {
  /** Provider of the model. */
  readonly provider: LlmProvider
  /** The selected model. */
  readonly model: LlmInfo
  /** Whether Lys loads and unloads the provider's models. */
  readonly canLoadModels: boolean
}

/**
 * Shows the Model pane's selected model: its status, facts, and load
 * settings, and makes it the session's default.
 *
 * @remarks Requires SettingsContext and the application
 * store, which owns every request: load, unload, and check go to the
 * provider; Set as default changes the session's default at once, and is
 * disabled while the model is being unloaded; Load and set as default
 * loads the model and makes it the default once the inventory lists it as
 * loaded, unless another default was chosen while it loaded. The parent
 * remounts it for each model.
 * @param props - Provider, model, and whether Lys loads its models.
 * @returns The details card.
 */
export default function ModelDetails({
  provider,
  model,
  canLoadModels
}: ModelDetailsProps): ReactElement {
  const headingId = useId()
  const { settings, onRuntimeChange } = useSettingsContext()
  const providerModels = useLysStore((state) => state.providerModels[provider])
  const loadModel = useLysStore((state) => state.loadModel)
  const unloadModel = useLysStore((state) => state.unloadModel)
  const testModel = useLysStore((state) => state.testModel)
  const reference = { provider, modelKey: model.modelKey }
  const { defaultModel } = settings.runtime
  const isDefault = isSameDefaultModel(defaultModel, reference)
  const { request } = providerModels
  const choice = findModelDefaultChoice(provider, model, isDefault, request)

  /** Loads the model, then makes it the default seen at this press. */
  function handleLoadDefaultModel(): void {
    const pressedDefault = defaultModel
    void loadModel(reference).then(() =>
      updateDefaultModelAfterLoad(reference, pressedDefault)
    )
  }

  return (
    <section
      aria-labelledby={headingId}
      className="settings-view__models-details"
    >
      <div className="settings-view__models-details-top">
        <ModelDetailsHeading
          headingId={headingId}
          isDefault={isDefault}
          modelKey={model.modelKey}
        />
        <ModelStatusPanel
          canLoadModels={canLoadModels}
          isDefault={isDefault}
          model={model}
          observation={providerModels}
          onCheckModel={() => void testModel(reference)}
          onLoadModel={() => void loadModel(reference)}
          onUnloadModel={() => void unloadModel(reference)}
          provider={provider}
        />
        <ModelFactList facts={listModelFacts(provider, model)} />
      </div>
      <ModelLoadConfigurationPanel model={model} provider={provider} />
      <ModelDefaultAction
        choice={choice}
        isDisabled={isModelDefaultActionDisabled(
          choice,
          request,
          model.modelKey
        )}
        onLoadDefaultModel={handleLoadDefaultModel}
        onSetDefaultModel={() => onRuntimeChange({ defaultModel: reference })}
      />
    </section>
  )
}
