import type { Job } from "@lys/share"

/**
 * Formats the text of a wake-up message, which the backend writes in a
 * delegator's conversation when reports of its jobs arrived.
 *
 * @param workingJobs - The conversation's jobs that are still working, in
 * the order the message names them.
 * @returns `Reports from your jobs arrived. No job is still working.` when
 * none works; otherwise `Reports from your jobs arrived. Still working: `,
 * then each job as `job <number> (<agent code>)`, joined by a comma and a
 * space, then a period.
 * @remarks A job is named by its agent's code, which holds no line break, so
 * the message stays on one line.
 */
export function formatWakeUpMessage(workingJobs: readonly Job[]): string {
  if (workingJobs.length === 0)
    return "Reports from your jobs arrived. No job is still working."
  const jobList = workingJobs
    .map((job) => `job ${job.number} (${job.agentCode})`)
    .join(", ")
  return `Reports from your jobs arrived. Still working: ${jobList}.`
}
