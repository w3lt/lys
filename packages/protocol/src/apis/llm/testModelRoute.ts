import * as z from "zod"
import { apiLlmTestModelRoute } from "./routes"

export const llmTestModelApiResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    modelId: z.string().min(1),
    status: z.literal("ready"),
    latencyMs: z.int32()
  }),

  z.strictObject({
    modelId: z.string().min(1),
    status: z.literal("not-ready"),
    reason: z.enum([
      "model-not-loaded",
      "runtime-unavailable",
      "probe-failed",
      "probe-timeout"
    ]),
    latencyMs: z.int32()
  })
])

export const llmTestModelApi = {
  method: "GET",
  path: apiLlmTestModelRoute,
  response: llmTestModelApiResponseSchema
}

export type LlmTestModelApiResponse = z.infer<typeof llmTestModelApi.response>

export type LlmTestModelApiRoute = {
  Reply: LlmTestModelApiResponse
}
