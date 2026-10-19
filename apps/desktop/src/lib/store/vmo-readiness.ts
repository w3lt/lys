import { getVmoHealth, getVmoStatus } from "@/lib/apis/tauri/vmo"

/**
 * Outcome of waiting for a started vmo.
 *
 * @remarks `ready`: vmo answered its health route. `exited`: the owned
 * process stopped before answering, for example because another vmo holds
 * its port. `unresponsive`: the process stayed alive without answering until
 * the timeout.
 */
export type VmoReadiness = "ready" | "exited" | "unresponsive"

/** Time between two checks of a started vmo, in milliseconds. */
const VMO_READINESS_CHECK_INTERVAL_MS = 1_000

/**
 * Longest time a started vmo is waited for, in milliseconds: long enough for
 * a first start, which downloads vmo's images, and for a development build,
 * which compiles vmo first.
 */
const VMO_READINESS_TIMEOUT_MS = 600_000

/**
 * Checks a started vmo until it answers its health route, its process exits,
 * or the readiness timeout passes.
 *
 * @returns The first readiness outcome observed.
 * @throws The Tauri rejection when the process status or the health check
 * cannot be read.
 * @remarks Each check reads the owned process first and asks the health
 * route only while it runs, so a vmo that has already exited is never
 * reported ready. The health route answers for whatever listens on vmo's
 * port: while the owned vmo is still starting, another vmo there, such as
 * one left by a Lys that died without quitting (#202), makes it ready.
 * Checks run every second for at most ten minutes of monotonic time. The
 * caller revalidates its own state before publishing.
 */
export async function getVmoReadiness(): Promise<VmoReadiness> {
  const deadlineMs = performance.now() + VMO_READINESS_TIMEOUT_MS
  while (performance.now() < deadlineMs) {
    if ((await getVmoStatus()).status !== "running") return "exited"
    if ((await getVmoHealth()) === "ready") return "ready"
    await new Promise<void>((resolve) => {
      setTimeout(resolve, VMO_READINESS_CHECK_INTERVAL_MS)
    })
  }
  return "unresponsive"
}
