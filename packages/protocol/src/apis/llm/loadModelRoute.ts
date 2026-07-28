import { LlmInfo } from "./_share"

export type LlmLoadModelApiRequestBody = {
  modelId: string
}

export type LlmLoadModelApiResponse = {
  llms: LlmInfo[]
}