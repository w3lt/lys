import { useId, type ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"
import type { LlmModelReference, LlmProvider } from "@lys/share"

import { useLysStore } from "@/lib/store"

import ModelDefaultAction from "./ModelDefaultAction"
import ModelLoadConfigurationPanel from "./ModelLoadConfigurationPanel"
import ModelStatusPanel from "./ModelStatusPanel"
import {
  findListedModel,
  findModelDefaultChoice,
  listModelFacts,
  splitModelKey
} from "./model-pane-presentation"
import { useSettingsContext } from "./SettingsContext"

/**
 * Makes a model the session's default once it is listed as loaded.
 *
 * @param reference - The model.
 * @remarks Reads the application store after a load settled, so the
 * settings and inventory are the current ones rather than those of the
 * render that started the load. A model the inventory does not list as
 * loaded is left as it is.
 */
function setLoadedDefaultModel(reference: LlmModelReference): void {
  const state = useLysStore.getState()
  const { inventory } = state.providerModels[reference.provider]
  if (findListedModel(inventory, reference.modelKey)?.loaded !== true) return
  const runtime = { ...state.settings.runtime, defaultModel: reference }
  state.setSettings({ ...state.settings, runtime })
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
 * @remarks Composition view over SettingsContext and the application
 * store, which owns every request: load, unload, and check go to the
 * provider; Set as default changes the session's default at once; Load and
 * set as default loads the model and makes it the default once the
 * inventory lists it as loaded. The parent remounts it for each model.
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
  const isDefault =
    defaultModel?.provider === provider &&
    defaultModel.modelKey === model.modelKey
  const { prefix, base, tag } = splitModelKey(model.modelKey)
  const { request } = providerModels
  const choice = findModelDefaultChoice(provider, model, isDefault, request)
  return (
    <section
      aria-labelledby={headingId}
      className="settings-view__models-details"
    >
      <div className="settings-view__models-details-top">
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
        <dl className="settings-view__models-facts">
          {listModelFacts(provider, model).map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ModelLoadConfigurationPanel model={model} provider={provider} />
      <ModelDefaultAction
        choice={choice}
        isDisabled={choice === "load-and-set" && request.status !== "idle"}
        onLoadDefaultModel={() =>
          void loadModel(reference).then(() => setLoadedDefaultModel(reference))
        }
        onSetDefaultModel={() => onRuntimeChange({ defaultModel: reference })}
      />
    </section>
  )
}
