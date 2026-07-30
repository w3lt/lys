import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import * as z from "zod"

if (process.env.NODE_ENV !== "test") {
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) })
}

const envSchema = z.object({
  BACKEND_HOST: z.string().default("127.0.0.1"),
  BACKEND_PORT: z.coerce.number().int().min(10000).max(65535).default(12345),
  LMSTUDIO_HOST: z.string().default("127.0.0.1"),
  LMSTUDIO_PORT: z.coerce.number().int().min(10000).max(65535).default(1234)
})

export type BackendEnv = z.infer<typeof envSchema>

export function loadEnv(input: NodeJS.ProcessEnv = process.env): BackendEnv {
  return envSchema.parse(input)
}
