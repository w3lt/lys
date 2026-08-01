import { create } from "zustand"
import { type Conversation } from "@lys/share"

type ChatViewState = {
  inputDraft: string
  conversation?: Conversation // undefined means new conversation
  streaming: boolean
}

type ChatViewAction = {
  setInputDraft: (draft: string) => void
  setConversation: (conversation?: Conversation) => void
  setStreaming: (streaming: boolean) => void
}

type ChatViewStore = ChatViewState & ChatViewAction

const initialState: ChatViewState = {
  inputDraft: "",
  conversation: undefined,
  streaming: false
}

export const useChatViewStore = create<ChatViewStore>((set) => ({
  ...initialState,

  setInputDraft: (draft) => {
    set({ inputDraft: draft })
  },

  setConversation: (conversation) => {
    set({ conversation })
  },

  setStreaming: (streaming) => {
    set({ streaming })
  }
}))
