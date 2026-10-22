import { loadBackendConfig } from "./config"
import { buildApp } from "./app"
import {
  BackendLogDestination,
  registerCrashLogging,
  registerOutputFailureListeners
} from "./log"

registerOutputFailureListeners(process.stdout, process.stderr)

const config = loadBackendConfig()
const logDestination = new BackendLogDestination(
  process.stdout,
  process.stderr,
  config.logsDirectoryPath
)
const app = await buildApp({ config, logDestination })
registerCrashLogging(process, app.log)

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
