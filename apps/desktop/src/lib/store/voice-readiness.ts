import { getVoiceHealth, getVoiceStatus } from "@/lib/apis/tauri/voice"

/**
 * Outcome of waiting for a started voice.
 *
 * @remarks `ready`: voice answered its health route. `exited`: the owned
 * process stopped before answering, for example because another voice holds
 * its port. `unresponsive`: the process stayed alive without answering until
 * the timeout.
 */
export type VoiceReadiness = "ready" | "exited" | "unresponsive"

/** Time between two checks of a started voice, in milliseconds. */
const VOICE_READINESS_CHECK_INTERVAL_MS = 1_000

/**
 * Longest time a started voice is waited for, in milliseconds: long enough
 * for a first start, which downloads about 780 MB of models, and for a
 * development build, which compiles voice first.
 */
const VOICE_READINESS_TIMEOUT_MS = 600_000

/**
 * Checks a started voice until it answers its health route, its process
 * exits, or the readiness timeout passes.
 *
 * @returns The first readiness outcome observed.
 * @throws The Tauri rejection when the process status or the health check
 * cannot be read.
 * @remarks Each check reads the owned process first and asks the health
 * route only while it runs, so a voice that has already exited is never
 * reported ready. The health route answers for whatever listens on voice's
 * port: while the owned voice is still starting, another voice there, such
 * as one left by a Lys that died without quitting (#202), makes it ready.
 * Checks run every second for at most ten minutes of monotonic time. The
 * caller revalidates its own state before publishing.
 */
export async function getVoiceReadiness(): Promise<VoiceReadiness> {
  return getVoiceReadinessBefore(performance.now() + VOICE_READINESS_TIMEOUT_MS)
}

/**
 * Checks a started voice once, then again after the check interval, until it
 * answers its health route, its process exits, or a moment passes.
 *
 * @param deadlineMs - Moment on the monotonic clock, as `performance.now()`
 * reads it, after which no check starts.
 * @returns The first readiness outcome observed; `unresponsive` once the
 * deadline passed before a check.
 * @throws The Tauri rejection when the process status or the health check
 * cannot be read.
 * @remarks Each check runs after the one before has finished.
 */
async function getVoiceReadinessBefore(
  deadlineMs: number
): Promise<VoiceReadiness> {
  if (performance.now() >= deadlineMs) return "unresponsive"
  if ((await getVoiceStatus()).status !== "running") return "exited"
  if ((await getVoiceHealth()) === "ready") return "ready"
  await new Promise<void>((resolve) => {
    setTimeout(resolve, VOICE_READINESS_CHECK_INTERVAL_MS)
  })
  return getVoiceReadinessBefore(deadlineMs)
}
