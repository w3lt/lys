import type { KeyboardEvent } from "react"
import { ArrowDown, Plus, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import "./Composer.scss"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"

interface ComposerProps {
  messageCount: number
  onSend: () => void
  onStop: () => void
}

/*
 * The meta row teaches the send shortcut while the chat is still empty, then
 * hands that space over to the session counters once there is history.
 */
function statusParts(messageCount: number): [string, string] {
  if (messageCount === 0) return ["Enter sends", "Shift+Enter for a newline"]
  return [
    `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
    "16384 context"
  ]
}

function runtimeLabel(
  backendServerStatus: BackendServerStatus,
  selectedModelLoaded: boolean
) {
  if (backendServerStatus !== "running") return "Backend offline"
  if (!selectedModelLoaded) return "No model loaded"
  return "Model ready"
}

export function Composer({ messageCount, onSend, onStop }: ComposerProps) {
  const { backendServerInfo, selectedModelLoaded, setActiveView } = useLysStore(
    (state) => state
  )
  const backendServerStatus = backendServerInfo.status

  // Input draft
  const { inputDraft, setInputDraft, setConversation, streaming } =
    useChatViewStore((state) => state)

  const runtimeAvailable =
    backendServerStatus === "running" && selectedModelLoaded

  const sendDisabled = streaming || !runtimeAvailable || !inputDraft.trim()
  const [statusLead, statusTrail] = statusParts(messageCount)

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
          <span>{runtimeLabel(backendServerStatus, selectedModelLoaded)}</span>
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
            onChange={(event) => setInputDraft(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Lys…"
            rows={1}
            value={inputDraft}
          />
          <Button
            aria-label="Send message"
            className={`composer__send${streaming ? " composer__send--beside-stop" : ""}`}
            disabled={sendDisabled}
            onClick={onSend}
            size="icon-lg"
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          {streaming && (
            <Button
              aria-label="Stop generating"
              className="composer__stop"
              onClick={onStop}
              size="icon-lg"
              variant="destructive"
            >
              <Square aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="composer__meta">
          <div className="composer__actions">
            <Button
              aria-label="New conversation"
              className="composer__new"
              onClick={() => setConversation(undefined)}
              size="sm"
              variant="ghost"
            >
              <Plus aria-hidden="true" className="size-3" />
              New
            </Button>
            <span aria-hidden="true" className="composer__divider" />
            <Button
              aria-label="Open model settings"
              className="composer__model"
              onClick={() => setActiveView("settings")}
              size="sm"
              variant="ghost"
            >
              <span
                aria-hidden="true"
                className={
                  runtimeAvailable
                    ? "composer__dot"
                    : "composer__dot composer__dot--off"
                }
              />
              Gemma 4 12B QAT
            </Button>
          </div>
          <div className="composer__status">
            <span>{statusLead}</span>
            <span aria-hidden="true">·</span>
            <span>{statusTrail}</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
