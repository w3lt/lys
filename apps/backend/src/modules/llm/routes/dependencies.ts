import { LMStudioClient } from "@lmstudio/sdk"

export type RegisterLlmRoutesOptions = {
  createClient: () => LMStudioClient
}
