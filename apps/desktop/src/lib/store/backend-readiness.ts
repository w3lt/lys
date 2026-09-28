import { getBackendStatus } from "@/lib/apis"
import { getBackendHealth } from "@/lib/apis/http/runtime"

/**
 * Outcome of waiting for a started backend.
 *
 * @remarks `ready`: the health route answered. `exited`: the process stopped
 * before answering. `unresponsive`: the process stayed alive without
 * answering until the timeout.
 */
export type BackendReadiness = "ready" | "exited" | "unresponsive"

/**
 * Checks a started backend until its health route answers, its process
 * exits, or the readiness timeout passes.
 *
 * @param backendUrl - Backend origin checked.
 * @returns The first readiness outcome observed.
 * @throws The Tauri rejection when the process status cannot be read.
 * @remarks Checks run every 250 ms, each bounded to one second, for at most
 * 30 seconds of monotonic time. The caller revalidates its own state before
 * publishing.
 */
export async function getBackendReadiness(
  backendUrl: string
): Promise<BackendReadiness> {
  const checkIntervalMs = 250
  const readinessTimeoutMs = 30_000
  const deadlineMs = performance.now() + readinessTimeoutMs
  while (performance.now() < deadlineMs) {
    if ((await getBackendHealth(backendUrl)) === "answering") return "ready"
    if (!(await getBackendStatus()).running) return "exited"
    await new Promise<void>((resolve) => {
      setTimeout(resolve, checkIntervalMs)
    })
  }
  return "unresponsive"
}
