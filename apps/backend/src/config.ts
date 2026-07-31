import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"

export type BackendConfig = {
  backendHost: string
  backendPort: number
  lmstudioHost: string
  lmstudioPort: number
}

export const config: BackendConfig = {
  backendHost: BACKEND_HOST,
  backendPort: BACKEND_PORT,
  lmstudioHost: LMSTUDIO_HOST,
  lmstudioPort: LMSTUDIO_PORT
}
