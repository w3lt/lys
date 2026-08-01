import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import type { PathLike } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Runtime network locations used by the backend and its LM Studio clients. */
export type BackendConfig = {
  /** Interface on which Fastify accepts connections. */
  backendHost: string
  /** TCP port on which Fastify accepts connections. */
  backendPort: number
  /** Host used by backend LM Studio clients. */
  lmstudioHost: string
  /** Port used by backend LM Studio clients. */
  lmstudioPort: number
  databaseFilePath: PathLike
}

/** Immutable-at-reference runtime configuration built from shared protocol constants. */
export const config: BackendConfig = {
  backendHost: BACKEND_HOST,
  backendPort: BACKEND_PORT,
  lmstudioHost: LMSTUDIO_HOST,
  lmstudioPort: LMSTUDIO_PORT,
  databaseFilePath: join(homedir(), ".lys", "conversations.sqlite")
}
