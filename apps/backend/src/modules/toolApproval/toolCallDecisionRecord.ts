import type { ToolCallDecision } from "./toolCallPolicy"

/**
 * Approval mode the gate applied to a call: Just run when the person saved
 * the tool so, Ask me otherwise, including when the saved choices could not
 * be read.
 */
export type ToolApprovalMode = "ask-me" | "just-run"

/**
 * How the backend decided one tool call before it ran, as stored with the
 * call.
 *
 * @remarks The person's answer and the call's outcome are not part of it:
 * they are stored later, as the call's state changes.
 */
export type ToolCallDecisionRecord = Readonly<{
  /**
   * The tool call policy's answer; undefined when Lys's own checks failed
   * the call first, because it names a tool the round did not offer or
   * arguments the tool cannot take, so the policy was never asked.
   */
  policyDecision: ToolCallDecision | undefined
  /**
   * Approval mode the gate applied; undefined when the call never reached
   * the gate, because the policy was not asked, it denied the call, or the
   * tool runs without approval.
   */
  approvalMode: ToolApprovalMode | undefined
}>
