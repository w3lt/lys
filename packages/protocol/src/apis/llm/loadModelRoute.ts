import * as z from "zod"
import { llmInfoSchema } from "./_share"
import { apiLlmLoadModelRoute } from "./routes"

export const llmLoadModelApiRequestBodySchema = z.strictObject({
  modelId: z.string().min(1)
})

export const llmLoadModelApi = {
  method: "POST",
  path: apiLlmLoadModelRoute,
  body: llmLoadModelApiRequestBodySchema,
  response: llmInfoSchema
}

export type LlmLoadModelApiRequestBody = z.infer<typeof llmLoadModelApi.body>

export type LlmLoadModelApiResponse = z.infer<typeof llmLoadModelApi.response>

export type LlmLoadModelApiRoute = {
  Body: LlmLoadModelApiRequestBody
  Reply: LlmLoadModelApiResponse
}
