import type {
  ConversationAssistantMessageFinishReason,
  ConversationAssistantMessageStatus,
  ConversationMetadata
} from "@lys/share"
import type { PathLike } from "node:fs"
import type { ConversationListCursor } from "./utils"

export type ListConversationMetadataOptions = {
  query?: string
  cursor?: string
  limit?: number
}

export type VerifiedListConversationMetadataOptions = {
  query: string
  cursor: ConversationListCursor | undefined
  limit: number
}

export type ListConversationMetadataResult = {
  conversations: ConversationMetadata[]
  total: number
  nextCursor: string | null
  hasNextPage: boolean
}

export type ConversationServiceCreationOptions = {
  databaseFilePath: PathLike
}

export type ConversationCreationOptions = {
  systemPrompt?: string
}

export type GetConversationMetadataOptions = {
  id: string
}

export type AddUserMessageToConversationOptions = {
  conversationId: string
  userMessageContent: string
}

export type AddAssistantMessageToConversationOptions = {
  conversationId: string
  assistantMessageContent: string
  model: string
  status: ConversationAssistantMessageStatus
  finishReason?: ConversationAssistantMessageFinishReason
}

export type UpdateAssistantMessageStateOptions = {
  assistantMessageId: string
  status?: ConversationAssistantMessageStatus | undefined
  finishReason?: ConversationAssistantMessageFinishReason | null | undefined
}

export type UpdateConversationTitleOptions = {
  conversationId: string
  conversationTitle: string
}

export const DEFAULT_CONVERSAION_LIST_LIMIT = 1
export const MAXIMUM_CONVERSATION_LIST_LIMIT = 50
