/**
 * Counts, for one reply, the calls of each tool the tool call policy did
 * not deny, which the policy reads as the call's usage in its task.
 *
 * @remarks Invariant: each count only grows, by one for each call added.
 * Created per reply and dropped with it; holds no resource. Concurrency
 * model: single-owner, used by one reply on the backend's event loop; each
 * operation is one synchronous step, so the calls of a round are counted in
 * the model's order.
 */
export default class ToolCallUsage {
  /** Calls the policy did not deny, by tool name. */
  readonly #counts = new Map<string, number>()

  /**
   * Counts the calls of one tool added so far.
   *
   * @param toolName - Name of the tool, as offered.
   * @returns The number of its calls added; 0 for a tool never added.
   */
  public countToolCalls(toolName: string): number {
    return this.#counts.get(toolName) ?? 0
  }

  /**
   * Adds one call of a tool that the policy did not deny.
   *
   * @param toolName - Name of the tool, as offered.
   */
  public addToolCall(toolName: string): void {
    this.#counts.set(toolName, this.countToolCalls(toolName) + 1)
  }
}
