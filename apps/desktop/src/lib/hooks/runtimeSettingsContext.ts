import { startBackend, stopBackend } from "../apis"

export default function useRuntimeSettingsContext() {
  return {
    startBackend,
    stopBackend
  }
}
