import type { JustRunToolNamesRead } from "../../infrastructure/settings/justRunToolsFile"
import ToolCallGate, { type SendToolApprovalPrompt } from "./toolCallGate"

/**
 * Reads the tools the person saved as Just run, again on every call; rejects
 * only when the underlying file cannot be closed.
 */
export type ReadJustRunToolNames = () => Promise<JustRunToolNamesRead>

/** Just run names used when the saved choices cannot be read: none. */
const NO_JUST_RUN_TOOL_NAMES: ReadonlySet<string> = new Set()

/**
 * Owns the reader of the saved Just run choices to decide which tool calls
 * need the person's approval, while preserving that a call never runs
 * without approval unless its tool was saved as Just run.
 *
 * @remarks This is the backend's approval gateway: every checked call of
 * every turn, client and backend tools alike, passes a {@link ToolCallGate}
 * created here before anything runs. The choices are read once per model
 * round, so a choice saved before a round's calls arrive applies to that
 * round. When the saved choices cannot be read, every call asks (it fails
 * closed). Concurrency model: reentrant; it owns no mutable state, and each
 * gate is independent.
 */
export default class ToolApprovalService {
  /** Reads the saved choices; lent by the composition root. */
  readonly #readJustRunToolNames: ReadJustRunToolNames

  /**
   * Creates the service.
   *
   * @param readJustRunToolNames - Reader of the saved choices, borrowed for
   * the service's lifetime.
   */
  public constructor(readJustRunToolNames: ReadJustRunToolNames) {
    this.#readJustRunToolNames = readJustRunToolNames
  }

  /**
   * Reads the saved choices and creates the gate of one model round.
   *
   * @param sendToolApprovalPrompt - Prompt sender of the reply the round
   * belongs to, borrowed by the gate for the round.
   * @param reportSettingsUnreadable - Called once when the saved choices
   * cannot be read, before the gate is returned; must not throw.
   * @returns A promise resolving with the gate: tools saved as Just run go on
   * at once, every other tool asks the person. When the choices cannot be
   * read, no tool is on Just run.
   * @throws The reader's failure, when the settings file cannot be closed.
   */
  public async createToolCallGate(
    sendToolApprovalPrompt: SendToolApprovalPrompt,
    reportSettingsUnreadable: () => void
  ): Promise<ToolCallGate> {
    const read = await this.#readJustRunToolNames()
    switch (read.status) {
      case "read":
        return new ToolCallGate(read.toolNames, sendToolApprovalPrompt)
      case "unreadable":
        reportSettingsUnreadable()
        return new ToolCallGate(NO_JUST_RUN_TOOL_NAMES, sendToolApprovalPrompt)
    }
  }
}
