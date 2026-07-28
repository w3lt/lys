import { LlmInfo } from "./_share"

export type LlmListModelsApiRequestBody = object

export type LlmListModelsApiResponse = {
  llms: LlmInfo[]
}