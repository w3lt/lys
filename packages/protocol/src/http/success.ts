import * as z from "zod"

export const httpSuccessResponseSchema = z.json()
export type HttpSuccessResponse = z.infer<typeof httpSuccessResponseSchema>