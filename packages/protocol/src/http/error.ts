import * as z from "zod"

export const httpErrorResponseSchema = z.strictObject({
  type: z.string().readonly(),
  title: z.string().readonly(),
  detail: z.string().readonly(),
  status: z.number().min(400).max(599).optional(),
  instance: z.string().optional()
})

export type HttpErrorResponse = z.infer<typeof httpErrorResponseSchema>