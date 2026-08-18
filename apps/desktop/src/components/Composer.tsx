import type { KeyboardEvent, ReactElement } from "react"
import { ArrowDown, Plus, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import "./Composer.scss"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"

/** Properties accepted by {@link Composer}. */
export type ComposerProps = {
  /** Number of transcript messages used for the composer status summary. */
  readonly messageCount: number
}

/** Immutable display copy for the leading and trailing composer status slots. */
type ComposerStatus = {
  /** Primary status text shown first in the composer footer. */
  readonly lead: string
  /** Supporting status text shown after the composer status separator. */
  readonly trail: string
}

/*
 * The meta row teaches the send shortcut while the chat is still empty, then
 * hands that space over to the session counters once there is history.
 */
/**
 * Formats the static composer status copy for the current transcript length.
 *
 * @param messageCount - Number of messages currently shown in the transcript.
 * @returns Immutable display copy for the composer footer status slots.
 */
function formatComposerStatus(messageCount: number): ComposerStatus {
  if (messageCount === 0) {
    return { lead: "Enter sends", trail: "Shift+Enter for a newline" }
  }

  return {
    lead: `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
    trail: "16384 context"
  }
}

/**
 * Formats the current local runtime availability for the composer warning.
 *
 * @param backendServerStatus - Observed backend process lifecycle status.
 * @param selectedModelLoaded - Whether the selected model is ready for use.
 * @returns Human-readable runtime availability.
 */
function formatRuntimeLabel(
  backendServerStatus: BackendServerStatus,
  selectedModelLoaded: boolean
): string {
  if (backendServerStatus !== "running") return "Backend offline"
  if (!selectedModelLoaded) return "No model loaded"
  return "Model ready"
}

/**
 * Renders the chat draft editor and controls for the owned chat lifecycle.
 *
 * @param props - Transcript count displayed in the composer status.
 * @returns The rendered conversation composer.
 */
export function Composer({ messageCount }: ComposerProps): ReactElement {
  const { backendServerInfo, selectedModelLoaded, setActiveView } = useLysStore(
    (state) => state
  )
  const backendServerStatus = backendServerInfo.status

  // Input draft
  const {
    inputDraft,
    request,
    resetConversation,
    sendMessage,
    setInputDraft,
    stopStreaming
  } = useChatViewStore((state) => state)

  const runtimeAvailable =
    backendServerStatus === "running" && selectedModelLoaded
  const isRequestActive = request.status !== "idle"

  const sendDisabled = isRequestActive || !inputDraft.trim()
  const { lead: statusLead, trail: statusTrail } =
    formatComposerStatus(messageCount)

  /**
   * Sends the current draft when Enter is pressed without a Shift modifier.
   *
   * @param event - Keyboard event emitted by the composer textarea.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return (
    <footer className="composer">
      {!runtimeAvailable && (
        <div className="composer__offline" role="status">
          <span>
            {formatRuntimeLabel(backendServerStatus, selectedModelLoaded)}
          </span>
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
            className={`composer__textarea${isRequestActive ? " composer__textarea--streaming" : ""}`}
            id="lys-composer"
            onChange={(event) => setInputDraft(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Lys…"
            rows={1}
            value={inputDraft}
          />
          <Button
            aria-label="Send message"
            className={`composer__send${isRequestActive ? " composer__send--beside-stop" : ""}`}
            disabled={sendDisabled}
            onClick={() => void sendMessage()}
            size="icon-lg"
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          {isRequestActive && (
            <Button
              aria-label="Stop generating"
              className="composer__stop"
              onClick={stopStreaming}
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
              onClick={resetConversation}
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
