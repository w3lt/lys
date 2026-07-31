import { config } from "./config"
import { buildApp } from "./app"

const app = await buildApp({ config })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
