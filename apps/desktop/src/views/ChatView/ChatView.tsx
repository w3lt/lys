import { lazy, useEffect, useMemo, useRef } from "react"
import { ArrowDown } from "lucide-react"

import { Button } from "@/components/ui/button"

import "./ChatView.scss"
import { Composer } from "@/components/Composer"
import { useChatViewStore } from "@/lib/store/chat-view"
import { chat } from "@/lib/apis/http/chat"

const StarterView = lazy(
  () => import("@/components/ChatViewComponents/StarterView")
)
const ConversationContent = lazy(
  () => import("@/components/ChatViewComponents/ConversationContent")
)

interface ChatViewProps {
  atBottom: boolean
  onScrollPositionChange: (atBottom: boolean) => void
}

export default function ChatView({
  atBottom,
  onScrollPositionChange
}: ChatViewProps) {
  const { streaming, conversation, inputDraft, setConversation } =
    useChatViewStore((state) => state)
  const messages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages]
  )
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = transcriptRef.current

    if (!element || !atBottom || messages.length === 0) return

    element.scrollTo?.({ top: element.scrollHeight })
  }, [atBottom, messages])

  function handleScroll() {
    const element = transcriptRef.current
    if (!element) return

    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    onScrollPositionChange(nearBottom)
  }

  function jumpToLatest() {
    const element = transcriptRef.current
    if (!element) return

    element.scrollTo?.({ top: element.scrollHeight, behavior: "smooth" })
    onScrollPositionChange(true)
  }

  const onSend = async () => {
    const events = chat({
      message: inputDraft,
      model: "google/gemma-4-12b-qat"
    })

    for await (const event of events) {
      switch (event.type) {
        case "start": {
          const { conversation, assistantMessageId } = event
          setConversation({
            ...conversation,
            messages: [
              {
                id: assistantMessageId,
                content: "",
                createdAt: new Date().toISOString(),
                role: "assistant",
                status: "streaming",
                model: "google/gemma-4-12b-qat",
                updatedAt: new Date().toISOString(),
                finishReason: null
              }
            ]
          })
          break
        }
        case "title": {
          if (!conversation) throw new Error("Conversation is undefined!!")
          setConversation((conv) => {
            if (!conv) return conv
            return {
              ...conv,
              title: event.title
            }
          })
          break
        }
        case "delta": {
          const delta = event.content
          setConversation((conv) => {
            if (!conv) return conv
            if (conv.messages.length === 0)
              throw new Error("No message to update!!!")

            const lastMessage = { ...conv.messages[conv.messages.length - 1] }
            lastMessage.content += delta
            const newMessages = [
              ...conv.messages.slice(0, conv.messages.length - 1),
              lastMessage
            ]
            return {
              ...conv,
              messages: newMessages
            }
          })
          break
        }
        case "done":
          // not for now
          break
        case "error":
          // now for now
          break
      }
    }
  }

  return (
    <main className="app-shell__chat">
      <section className="chat-view" aria-label="Conversation">
        <div
          className="chat-view__scroller"
          data-testid="transcript"
          onScroll={handleScroll}
          ref={transcriptRef}
        >
          {messages.length === 0 ? (
            <StarterView onSend={onSend} />
          ) : (
            <ConversationContent messages={messages} />
          )}
        </div>

        {!atBottom && (
          <Button
            className="chat-view__jump"
            onClick={jumpToLatest}
            size="sm"
            variant="outline"
          >
            <ArrowDown aria-hidden="true" />
            Jump to latest
          </Button>
        )}

        {streaming && (
          <span className="sr-only">Lys is generating a reply</span>
        )}
      </section>

      <Composer
        messageCount={messages.length}
        onSend={() => {
          void onSend()
        }}
        onStop={() => null}
      />
    </main>
  )
}
