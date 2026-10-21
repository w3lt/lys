import { loadBackendConfig } from "./config"
import { buildApp } from "./app"

const config = loadBackendConfig()
const app = await buildApp({ config, logDestination: process.stdout })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
