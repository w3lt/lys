import {
  estimateTextTokens,
  formatTokenCount
} from "@/components/ComposerComponents/composer-context"
import type { AgentDraftProblem, StoredAgentActivity } from "@/lib/store/agents"

/**
 * Formats the sentence explaining why a draft cannot be saved.
 *
 * @param problem - First problem found in the draft.
 * @returns A sentence naming the problem and how to correct it.
 */
export function formatAgentDraftProblem(problem: AgentDraftProblem): string {
  switch (problem.kind) {
    case "name-missing":
      return "An agent needs a name."
    case "name-taken":
      return `Another agent already goes by ${problem.name}. Pick another name.`
    case "code-malformed":
      return "A code is lowercase letters and digits, in groups joined by single hyphens, and cannot end with a hyphen."
    case "code-taken":
      return `Another agent already uses the code ${problem.code}. Pick another code, or leave it empty.`
    case "bio-missing":
      return "Give the agent a one-line bio."
    case "system-prompt-missing":
      return "Write a system prompt, even one line."
  }
}

/**
 * Formats the count shown beside the heading of the user's agents.
 *
 * @param agentCount - Number of stored agents.
 * @returns `deletable` when there are none, otherwise `<count> saved ·
 * deletable`.
 */
export function formatCustomAgentCount(agentCount: number): string {
  return agentCount === 0 ? "deletable" : `${agentCount} saved · deletable`
}

/**
 * Formats the measure shown under the system prompt.
 *
 * @param systemPrompt - Prompt as typed.
 * @param contextSize - Local estimate of the context window, in tokens.
 * @returns The prompt's length in characters, its estimated tokens, and,
 * when the window is not empty, the share of it those tokens take, such as
 * `412 chars · ~112 tokens · 1.4% of 8.2k`. Every token figure is an
 * estimate.
 */
export function formatAgentPromptMeasure(
  systemPrompt: string,
  contextSize: number
): string {
  const tokenCount = estimateTextTokens(systemPrompt)
  const measure = `${systemPrompt.length} chars · ~${tokenCount} tokens`
  if (contextSize <= 0) return measure

  const windowShare = ((tokenCount / contextSize) * 100).toFixed(1)
  return `${measure} · ${windowShare}% of ${formatTokenCount(contextSize)}`
}

/**
 * Formats the status announced while a change to an agent is pending.
 *
 * @param activity - Change or confirmation in progress in the editor.
 * @returns `Saving…` or `Deleting…` while a change awaits the backend, and an
 * empty string otherwise, which leaves nothing to announce.
 */
export function formatAgentActivityStatus(
  activity: StoredAgentActivity
): string {
  switch (activity.status) {
    case "saving":
      return "Saving…"
    case "deleting":
      return "Deleting…"
    case "idle":
    case "confirming-delete":
      return ""
  }
}
