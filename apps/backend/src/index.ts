import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { BackendConfig, buildApp } from "./app"

const config: BackendConfig = {
  backendHost: BACKEND_HOST,
  backendPort: BACKEND_PORT,
  lmstudioHost: LMSTUDIO_HOST,
  lmstudioPort: LMSTUDIO_PORT
}

const app = await buildApp({ config })

await app.listen({
  host: config.backendHost,
  port: config.backendPort
})
