import { create } from "zustand"
import { type Conversation } from "@lys/share"

type StateUpdater<T> = T | ((current: T) => T)

type ChatViewState = {
  inputDraft: string
  conversation?: Conversation // undefined means new conversation
  streaming: boolean
}

type ChatViewAction = {
  setInputDraft: (draft: string) => void
  setConversation: (updater: StateUpdater<Conversation | undefined>) => void
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

  setConversation: (update) => {
    set((state) => ({
      conversation:
        typeof update === "function" ? update(state.conversation) : update
    }))
  },

  setStreaming: (streaming) => {
    set({ streaming })
  }
}))
