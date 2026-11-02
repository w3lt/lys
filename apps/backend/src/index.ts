import { loadBackendConfig, loadBackendLogsDirectoryPath } from "./config"
import { buildApp } from "./app"
import { registerBackendStopHandlers } from "./processStop"
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
registerBackendStopHandlers({
  backendProcess: process,
  exitProcess: (code) => process.exit(code),
  logger,
  stopEveryMcpServerProcess: () => app.mcpServerProcessGroups.stopEveryGroup()
})

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
