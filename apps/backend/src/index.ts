import { loadBackendConfig } from "./config"
import { buildApp } from "./app"
import { registerOutputFailureListeners } from "./log"

registerOutputFailureListeners(process.stdout, process.stderr)

const config = loadBackendConfig()
const app = await buildApp({ config, logDestination: process.stdout })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
