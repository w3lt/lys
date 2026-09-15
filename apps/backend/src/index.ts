import { loadBackendConfig } from "./config"
import { buildApp } from "./app"

const config = loadBackendConfig()
const app = await buildApp({ config })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
