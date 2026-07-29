import * as z from "zod"
import { llmInfoSchema } from "./_share"
import { apiLlmListModelsRoute } from "./routes"

export const llmListModelsApiResponseSchema = z.strictObject({
  llms: z.array(llmInfoSchema)
})

export const llmListModelsApi = {
  method: "GET",
  path: apiLlmListModelsRoute,
  response: llmListModelsApiResponseSchema
} as const

export type LlmListModelsApiResponse = z.infer<typeof llmListModelsApi.response>

export type LlmListModelsApiRoute = {
  Reply: LlmListModelsApiResponse
}
