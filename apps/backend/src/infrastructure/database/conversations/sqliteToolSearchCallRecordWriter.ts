import type { ToolCallReplyPart } from "@lys/share"
import type {
  CreateToolSearchCallRecordInput,
  ToolSearchCallRecordWriter
} from "../../../modules/conversation/records"
import type { ToolCallDecisionRecord } from "../../../modules/toolApproval/toolCallDecisionRecord"
import { TOOL_CALL_POLICY_ID } from "../../../modules/toolApproval/toolCallPolicy"
import type { DatabaseWriter } from "../databaseTransactions"

/**
 * Stores the decision record of one call of a tool search's reply, taking
 * its conversation from the search's `find_tools` call, which must be a
 * stored tool call that is running; bound to the call's identity, the
 * agent, the tool, the argument text, the policy's effect, reason, and
 * identity, the outcome, and the times, then the `find_tools` call.
 */
const CREATE_TOOL_SEARCH_CALL_RECORD_SQL = `INSERT INTO tool_search_call_decisions
  (call_id, search_call_id, conversation_id, agent_code, tool_name,
    argument_text, policy_effect, policy_reason, policy_id, outcome,
    created_at, updated_at)
  SELECT ?, s.id, s.conversation_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
  FROM conversation_messages s
  WHERE s.id = ? AND s.role = 'tool_call' AND s.status = 'running'`

/**
 * Stores how a recorded running call ended; bound to the outcome and the
 * update time, then the call.
 */
const UPDATE_TOOL_SEARCH_CALL_OUTCOME_SQL = `UPDATE tool_search_call_decisions
  SET outcome = ?, updated_at = ?
  WHERE call_id = ? AND outcome = 'running'`

/** Policy columns of one search call's record. */
type ToolSearchCallPolicyColumns = Readonly<{
  /** The policy's effect; null when Lys's own checks failed the call first. */
  policyEffect: string | null
  /** The rule behind a denial; null otherwise. */
  policyReason: string | null
  /** Identity of the rule set that decided the call; null with the effect. */
  policyId: string | null
}>

/**
 * Builds the policy columns of one search call's record.
 *
 * @param decision - How the call was decided.
 * @returns The policy's effect, the rule behind it, and the identity of the
 * rule set, which is this build's; null where the decision has none.
 * @throws If the decision has an approval mode: a search's call never
 * reaches the approval gate.
 */
function buildPolicyColumns(
  decision: ToolCallDecisionRecord
): ToolSearchCallPolicyColumns {
  if (decision.approvalMode !== undefined)
    throw new Error("A tool search's call never reaches the approval gate")
  const { policyDecision } = decision
  return {
    policyEffect: policyDecision?.effect ?? null,
    policyReason:
      policyDecision === undefined || policyDecision.effect === "allow"
        ? null
        : policyDecision.reason,
    policyId: policyDecision === undefined ? null : TOOL_CALL_POLICY_ID
  }
}

/**
 * Reads the outcome a search's call is recorded with when kept.
 *
 * @param call - The call as the search's reply kept it.
 * @returns Its status, `running` or `failed`.
 * @throws For any other status, which a kept call of a search cannot have.
 */
function readKeptOutcome(call: ToolCallReplyPart): "running" | "failed" {
  if (call.status === "running" || call.status === "failed") return call.status
  throw new Error(`A tool search's call cannot be kept ${call.status}`)
}

/**
 * Reads the outcome a recorded running call of a search ended with.
 *
 * @param call - The call as the search's reply kept it after the change.
 * @returns Its status, `succeeded` or `failed`.
 * @throws For any other status, which no run ends with.
 */
function readEndedOutcome(call: ToolCallReplyPart): "succeeded" | "failed" {
  if (call.status === "succeeded" || call.status === "failed")
    return call.status
  throw new Error(`A tool search's call cannot end ${call.status}`)
}

/**
 * Borrows the shared database's write transactions to store the decision
 * records of the tool calls of tool searches' replies.
 *
 * @remarks Owns no resource: the database's owner closes the connection,
 * after which every operation fails with `Database is closed`. Each call is
 * one write transaction that commits before it returns. Concurrency model:
 * single-owner, synchronous on the backend's event loop. Implements
 * {@link ToolSearchCallRecordWriter}.
 */
export default class SqliteToolSearchCallRecordWriter implements ToolSearchCallRecordWriter {
  /** Borrowed write transactions for every record. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   *
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
  }

  /**
   * Implements {@link ToolSearchCallRecordWriter.createToolSearchCallRecord}.
   *
   * @param input - Interface-defined search, agent, call, and decision.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed, write, and contract failures; a
   * call or decision a search's call cannot have fails before the write.
   */
  public createToolSearchCallRecord(
    input: CreateToolSearchCallRecordInput
  ): boolean {
    const { call } = input
    const outcome = readKeptOutcome(call)
    const { policyEffect, policyReason, policyId } = buildPolicyColumns(
      input.decision
    )
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(CREATE_TOOL_SEARCH_CALL_RECORD_SQL)
          .run(
            call.id,
            input.agentCode,
            call.toolName,
            call.argumentText,
            policyEffect,
            policyReason,
            policyId,
            outcome,
            call.createdAt,
            call.updatedAt,
            input.searchCallId
          ).changes === 1
    )
  }

  /**
   * Implements {@link ToolSearchCallRecordWriter.updateToolSearchCallOutcome}.
   *
   * @param call - Interface-defined call after its change.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed, write, and contract failures; a
   * status no run ends with fails before the write.
   */
  public updateToolSearchCallOutcome(call: ToolCallReplyPart): boolean {
    const outcome = readEndedOutcome(call)
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(UPDATE_TOOL_SEARCH_CALL_OUTCOME_SQL)
          .run(outcome, call.updatedAt, call.id).changes === 1
    )
  }
}
