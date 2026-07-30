import { buildApp } from "./app"
import { loadEnv } from "./env"

const env = loadEnv()
const app = await buildApp({ env })

await app.listen({
  host: env.BACKEND_HOST,
  port: env.BACKEND_PORT
})
