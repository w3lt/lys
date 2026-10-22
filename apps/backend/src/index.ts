import { loadBackendConfig, loadBackendLogsDirectoryPath } from "./config"
import { buildApp } from "./app"
import {
  BackendLogDestination,
  createBackendLogger,
  registerOutputFailureListeners,
  registerProcessLogging
} from "./log"

registerOutputFailureListeners(process.stdout, process.stderr)

const logger = createBackendLogger(
  new BackendLogDestination(
    process.stdout,
    process.stderr,
    loadBackendLogsDirectoryPath()
  )
)
registerProcessLogging(process, logger)

const config = loadBackendConfig()
const app = await buildApp({ config, logger })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
