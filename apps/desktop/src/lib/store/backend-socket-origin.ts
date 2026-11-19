import { useLysStore } from "@/lib/store"

/**
 * Reads the backend's base as a WebSocket origin.
 *
 * @returns The application store's backend URL with its `http` scheme
 * replaced by `ws`, so `https` becomes `wss`.
 */
export function readBackendSocketOrigin(): string {
  return useLysStore.getState().backendUrl.replace(/^http/, "ws")
}
