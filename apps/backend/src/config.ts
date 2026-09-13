import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import type { PathLike } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Runtime locations and limits used by the backend and its LM Studio clients. */
export type BackendConfig = {
  /** Interface on which Fastify accepts connections. */
  backendHost: string
  /** TCP port on which Fastify accepts connections. */
  backendPort: number
  /** Host used by backend LM Studio clients. */
  lmstudioHost: string
  /** Port used by backend LM Studio clients. */
  lmstudioPort: number
  /** Filesystem path of the SQLite database owned by the conversation service. */
  databaseFilePath: PathLike
  /**
   * Inclusive maximum number of title-generation requests for one new
   * conversation, passed to the chat routes when they are registered.
   *
   * @remarks The chat routes reject a value that is not a positive safe
   * integer. The value is read once at startup.
   */
  titleGenerationMaxAttempts: number
}

/** Immutable-at-reference runtime configuration built from shared protocol constants and backend defaults. */
export const config: BackendConfig = {
  backendHost: BACKEND_HOST,
  backendPort: BACKEND_PORT,
  lmstudioHost: LMSTUDIO_HOST,
  lmstudioPort: LMSTUDIO_PORT,
  databaseFilePath: join(homedir(), ".lys", "lys_db.sqlite"),
  titleGenerationMaxAttempts: 3
}
