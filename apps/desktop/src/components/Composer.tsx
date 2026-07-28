import type { KeyboardEvent } from "react"
import { ArrowDown, Plus, Square } from "lucide-react"

import type { LysConfig, RuntimeState } from "@/app/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import "./Composer.css"

interface ComposerProps {
  config: LysConfig
  draft: string
  messageCount: number
  runtime: RuntimeState
  streaming: boolean
  onDraftChange: (draft: string) => void
  onNewChat: () => void
  onOpenModelSettings: () => void
  onSend: () => void
  onStop: () => void
}

function runtimeLabel(runtime: RuntimeState) {
  if (runtime.backend !== "running") return "Backend offline"
  if (runtime.model === "loading") return `Loading model · ${runtime.modelProgress}%`
  if (runtime.model === "unloading") return "Releasing model"
  if (runtime.model !== "loaded") return "No model loaded"
  return "Model ready"
}

export function Composer({
  config,
  draft,
  messageCount,
  runtime,
  streaming,
  onDraftChange,
  onNewChat,
  onOpenModelSettings,
  onSend,
  onStop,
}: ComposerProps) {
  const runtimeAvailable =
    runtime.backend === "running" && runtime.model === "loaded"
  const sendDisabled = streaming || !runtimeAvailable || !draft.trim()

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <footer className="composer">
      {!runtimeAvailable && (
        <div className="composer__offline" role="status">
          <span>{runtimeLabel(runtime)}</span>
          <span>Open model settings to restore local generation.</span>
        </div>
      )}

      <div className="composer__inner">
        <div className="composer__input-wrap">
          <label className="sr-only" htmlFor="lys-composer">
            Message Lys
          </label>
          <Textarea
            aria-label="Message Lys"
            className={`composer__textarea${streaming ? " composer__textarea--streaming" : ""}`}
            id="lys-composer"
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Lys…"
            rows={1}
            value={draft}
          />
          <Button
            aria-label="Send message"
            className={`composer__send${streaming ? " composer__send--beside-stop" : ""}`}
            disabled={sendDisabled}
            onClick={onSend}
            size="icon"
            variant="lysPrimary"
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          {streaming && (
            <Button
              aria-label="Stop generating"
              className="composer__stop"
              onClick={onStop}
              size="icon"
              variant="lysDanger"
            >
              <Square aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="composer__meta">
          <div className="composer__session">
            <span>{messageCount} messages</span>
            <span aria-hidden="true">·</span>
            <span>{config.contextSize.toLocaleString()} context</span>
          </div>
          <div className="composer__actions">
            <Button
              aria-label="Open model settings"
              onClick={onOpenModelSettings}
              variant="lysGhost"
            >
              <span
                aria-hidden="true"
                className={runtimeAvailable ? "composer__dot" : "composer__dot composer__dot--off"}
              />
              {config.model}
            </Button>
            <Button
              aria-label="New conversation"
              onClick={onNewChat}
              variant="lysGhost"
            >
              <Plus aria-hidden="true" />
              New
            </Button>
          </div>
        </div>
      </div>
    </footer>
  )
}
